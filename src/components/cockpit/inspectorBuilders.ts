import type {
  MatchComparisonArtifact,
  MatchComparisonFilteredProjection,
  MatchComparisonRow
} from "../../harness/matchComparisonView";
import type {
  SocialNetworkCommunicationEdgeDto,
  SocialNetworkExposureEdgeDto,
  SocialNetworkRelationshipEdgeDto
} from "../../server/artifactProjection";
import type {
  AgentHarnessState,
  HarnessEvaluationWarning,
  HarnessMetricRecord,
  HarnessMetricPromotionDecision
} from "../../harness/types";
import { countSocialStepCommits, type SocialMessage } from "../../harness/social";
import type {
  BranchTreeSummary,
  CheckpointSummary,
  ForkLineageSummary,
  InspectorItem,
  MatchRecord,
  ProjectedMatchArtifact,
  ProjectedSocialStep,
  ReplayResponse,
  TournamentArtifactSetSummary,
  TournamentComparisonAggregateView,
  TournamentPublicShareSummary
} from "./cockpitTypes";
import {
  formatDate,
  formatPackCommitDensity,
  readSocialCommandType,
  readSocialCommitStatus,
  readSocialPendingKind,
  shortId,
  summarizeSpeechActKinds,
  uniqueStrings
} from "./formatters";

export function inspectorFromArtifact(artifact: ProjectedMatchArtifact): InspectorItem {
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    kind: "artifact",
    title: `Match Artifact ${shortId(artifact.runId)}`,
    subtitle: `${artifact.artifactVersion} · ${artifact.status}`,
    fields: [
      ["run", artifact.runId],
      ["seed", artifact.seed],
      ["status", artifact.status],
      ["native steps", stepCounts.nativeSteps],
      ["committed steps", stepCounts.committedSteps],
      ["rejected steps", stepCounts.rejectedSteps],
      ["legacy projection", artifact.trajectory.length],
      ["messages", artifact.socialEpisode.messages.length],
    ],
    json: {
      artifactVersion: artifact.artifactVersion,
      runId: artifact.runId,
      projection: artifact.projection,
      status: artifact.status,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      legacyTrajectoryProjection: artifact.trajectory.length,
      socialMessages: artifact.socialEpisode.messages.length,
      evaluationReport: artifact.evaluationReport
    }
  };
}

export function inspectorFromMatch(match: MatchRecord): InspectorItem {
  return {
    kind: "match-record",
    title: `Run ${shortId(match.id)}`,
    subtitle: `${match.status} · ${formatDate(match.createdAt)}`,
    fields: [
      ["id", match.id],
      ["status", match.status],
      ["harness", match.harnessStatus ?? "n/a"],
      ["artifact", String(Boolean(match.hasArtifact))],
      ["native steps", typeof match.nativeSteps === "number" ? match.nativeSteps : "n/a"],
      ["committed steps", typeof match.committedSteps === "number" ? match.committedSteps : "n/a"],
      ["rejected steps", typeof match.rejectedSteps === "number" ? match.rejectedSteps : "n/a"],
      ["legacy projection", typeof match.legacyProjectionSteps === "number" ? match.legacyProjectionSteps : typeof match.trajectorySteps === "number" ? match.trajectorySteps : "n/a"]
    ],
    json: match
  };
}

export function inspectorFromSocialStep(step: ProjectedSocialStep, index: number): InspectorItem {
  return {
    kind: "native-social-step",
    title: `Native Step #${index + 1}`,
    subtitle: `${step.actorId} · ${readSocialCommitStatus(step)} · ${readSocialCommandType(step)}`,
    fields: [
      ["trace", step.traceId],
      ["scheduler turn", step.turnIndex],
      ["actor", step.actorId],
      ["profile", step.profileId ?? "n/a"],
      ["commit status", readSocialCommitStatus(step)],
      ["failure stage", step.failure?.stage ?? (step.error ? "legacy_error" : "n/a")],
      ["scheduler", step.schedulerMode],
      ["action", step.action.kind],
      ["command", readSocialCommandType(step)],
      ["pre hash", step.preStateHash ?? "n/a"],
      ["post hash", step.postStateHash ?? "n/a"]
    ],
    json: safeSocialStepInspectorJson(step, index)
  };
}

export function inspectorFromAgent(agent: AgentHarnessState): InspectorItem {
  return {
    kind: "agent",
    title: `Agent ${agent.playerId}`,
    subtitle: `${agent.policyName} · ${agent.model}`,
    fields: [
      ["profile", agent.profileId ?? "n/a"],
      ["turns", agent.turns],
      ["observations", agent.observations],
      ["beliefs", Object.keys(agent.beliefs ?? {}).length],
      ["private memos", agent.privateMemos.length],
      ["last intent", agent.lastIntent ?? "n/a"],
      ["social hash", agent.socialStateHash ?? "n/a"]
    ],
    json: safeAgentInspectorJson(agent)
  };
}

export function inspectorFromMessage(message: SocialMessage): InspectorItem {
  return {
    kind: "social-message",
    title: `Message #${message.seq}`,
    subtitle: `${message.channelId} · ${message.visibility}`,
    fields: [
      ["id", message.id],
      ["sender", message.senderId],
      ["recipients", message.recipientIds.join(", ") || "n/a"],
      ["channel", message.channelId],
      ["visibility", message.visibility],
      ["speech acts", message.speechActs?.length ?? 0],
      ["act kinds", summarizeSpeechActKinds(message)],
      ["receipts", message.deliveryReceipts?.length ?? 0],
      ["created", message.createdAt],
      ["content", message.content]
    ],
    json: safeMessageInspectorJson(message)
  };
}

export function inspectorFromSocialExposure(edges: readonly SocialNetworkExposureEdgeDto[]): InspectorItem {
  const edge = edges[0]!;
  const channels = Array.from(new Set(edges.map((item) => item.channelId))).sort();
  const visibilities = Array.from(new Set(edges.map((item) => item.visibility))).sort();
  const kinds = Array.from(new Set(edges.map((item) => item.kind ?? "message"))).sort();
  const messageRefs = new Map(edges.flatMap((item) => item.messageRefs).map((ref) => [ref.id, ref]));
  const actionKinds = Array.from(new Set(edges.flatMap((item) => item.actionKinds))).sort();
  const traceIds = Array.from(new Set(edges.flatMap((item) => item.traceIds))).sort();
  const turnIndexes = Array.from(new Set(edges.flatMap((item) => item.turnIndexes))).sort((left, right) => left - right);
  return {
    kind: "social-exposure",
    title: `Exposure ${edge.sourceId} → ${edge.targetId}`,
    subtitle: `显示汇总 · ${edges.length} 条服务端投影边`,
    fields: [
      ["source", edge.sourceId],
      ["observer", edge.targetId],
      ["server edges", edges.length],
      ["channels", channels.join(", ")],
      ["visibilities", visibilities.join(", ")],
      ["kinds", kinds.join(", ")],
      ["messages", messageRefs.size],
      ["observations", edges.reduce((sum, item) => sum + item.observationCount, 0)],
      ["evidence", edges.reduce((sum, item) => sum + item.evidenceCount, 0)],
      ["action kinds", actionKinds.join(", ") || "n/a"],
      ["traces", traceIds.map(shortId).join(", ") || "n/a"],
      ["turns", turnIndexes.join(", ") || "n/a"]
    ],
    json: {
      kind: "social-exposure-display-summary",
      source: "server.social-network-projection.v1",
      serverEdges: edges
    }
  };
}

export function inspectorFromSocialRelationship(edge: SocialNetworkRelationshipEdgeDto): InspectorItem {
  return {
    kind: "social-relationship",
    title: `关系 ${edge.sourceId} → ${edge.targetId}`,
    subtitle: `最终 Agent 快照 · ${edge.evidenceRefs.length} 条证据`,
    fields: [
      ["观察者", edge.sourceId],
      ["目标", edge.targetId],
      ["信任", edge.trust],
      ["怀疑", edge.suspicion],
      ["亲和", edge.affinity],
      ["影响", edge.influence],
      ["尊重", edge.respect],
      ["威胁", edge.threat],
      ["关系债务", edge.debt],
      ["更新", edge.updatedAt],
      ["证据 refs", edge.evidenceRefs.length]
    ],
    json: edge
  };
}

export function inspectorFromSocialCommunication(edges: readonly SocialNetworkCommunicationEdgeDto[]): InspectorItem {
  const edge = edges[0]!;
  const channels = Array.from(new Set(edges.map((item) => item.channelId))).sort();
  const visibilities = Array.from(new Set(edges.map((item) => item.visibility))).sort();
  const messageSeqs = Array.from(new Set(edges.flatMap((item) => item.messageSeqs))).sort((left, right) => left - right);
  return {
    kind: "social-communication",
    title: `通信 ${edge.sourceId} → ${edge.targetId}`,
    subtitle: `显示汇总 · ${edges.length} 条服务端投影边`,
    fields: [
      ["来源", edge.sourceId],
      ["目标", edge.targetId],
      ["服务端边", edges.length],
      ["通道", channels.join(", ")],
      ["可见性", visibilities.join(", ")],
      ["消息数", messageSeqs.length],
      ["消息序号", messageSeqs.join(", ") || "n/a"]
    ],
    json: {
      kind: "social-communication-display-summary",
      source: "server.social-network-projection.v1",
      serverEdges: edges
    }
  };
}

export function inspectorFromMetric(metric: HarnessMetricRecord, decision: HarnessMetricPromotionDecision): InspectorItem {
  return {
    kind: "metric",
    title: metric.label,
    subtitle: `${metric.id} · ${metric.scope}`,
    fields: [
      ["value", metric.value],
      ["scope", metric.scope],
      ["subject", metric.subjectId ?? "episode"],
      ["source", metric.evaluatorId ?? metric.source],
      ["weight", metric.weight ?? "n/a"],
      ["promotionClass", decision.promotionClass],
      ["scorecardEligible", decision.eligibleForScorecard],
      ["promotionReasons", decision.reasons.join(", ") || "n/a"],
      ["confidence", metric.confidence ?? "n/a"],
      ["evidence", metric.evidenceRefs?.length ?? 0]
    ],
    json: metric
  };
}

export function inspectorFromTournamentComparison(
  comparison: TournamentComparisonAggregateView,
  pack: TournamentArtifactSetSummary,
  actions: NonNullable<InspectorItem["actions"]> = [],
  options?: { activeComparisonId?: string | null }
): InspectorItem {
  const activeComparisonId = options?.activeComparisonId ?? null;
  const topMetrics = comparison.metricChangeFrequency
    .slice(0, 5)
    .map((metric) => `${metric.metricKey}×${metric.changedPairCount}/${metric.pairCount}`)
    .join(", ");
  const pairSummary = comparison.pairs
    .slice(0, 5)
    .map((pair) => {
      const density =
        typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
          ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
          : "";
      const label = `e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}:${shortId(pair.comparisonId)}${density}`;
      return pair.comparisonId === activeComparisonId ? `${label}*` : label;
    })
    .join(", ");
  return {
    kind: "tournament-comparison",
    title: `Tournament comparison ${shortId(comparison.comparisonSetId)}`,
    subtitle: `${comparison.artifactVersion} · ${comparison.view}`,
    fields: [
      ["artifactSetId", pack.artifactSetId],
      ["comparisonSetId", comparison.comparisonSetId],
      ["tournamentSeed", comparison.tournamentSeed],
      ["experimentId", comparison.experimentId ?? "n/a"],
      ["gamesRequested", comparison.gamesRequested],
      ["artifactMatchCount", comparison.artifactMatchCount],
      ["pairCount", comparison.pairCount],
      ["active pair", activeComparisonId ? shortId(activeComparisonId) : "n/a"],
      ["changed pairs", comparison.summary.changedPairCount],
      ["total changed rows", comparison.summary.totalChangedRows],
      ["average changed rows", comparison.summary.averageChangedRows],
      ["scorecard metric delta total", comparison.summary.totalScorecardMetricDelta],
      ["diagnostic metric delta total", comparison.summary.totalDiagnosticMetricDelta],
      ["benchmark_only metric delta total", comparison.summary.totalBenchmarkOnlyMetricDelta],
      ["promotion provenance changed metrics", comparison.summary.totalPromotionProvenanceChangedMetrics],
      ["evidence identity changed metrics", comparison.summary.totalEvidenceIdentityChangedMetrics],
      [
        "social steps delta total",
        typeof comparison.summary.totalSocialStepsDelta === "number" ? comparison.summary.totalSocialStepsDelta : "n/a"
      ],
      [
        "committed steps delta total",
        typeof comparison.summary.totalCommittedStepsDelta === "number"
          ? comparison.summary.totalCommittedStepsDelta
          : "n/a"
      ],
      [
        "rejected steps delta total",
        typeof comparison.summary.totalRejectedStepsDelta === "number"
          ? comparison.summary.totalRejectedStepsDelta
          : "n/a"
      ],
      ["pair identity hash", comparison.summary.pairIdentityHash],
      ["top changed metrics", topMetrics || "n/a"],
      ["pairs", pairSummary || "n/a"],
      ["projection", comparison.projection?.view ?? comparison.view]
    ],
    json: comparison,
    actions
  };
}

export function inspectorFromPackShare(share: TournamentPublicShareSummary): InspectorItem {
  return {
    kind: "tournament-public-share",
    title: `Share ${shortId(share.shareId)}`,
    subtitle: share.label ?? share.artifactSetId,
    fields: [
      ["shareId", share.shareId],
      ["artifactSetId", share.artifactSetId],
      ["expiresAt", share.expiresAt ?? "never"],
      ["expired", String(Boolean(share.expired))],
      ["relativeFiles", share.relativeFiles?.join(", ") ?? "all registered files"],
      ["detailViews", String(share.analytics?.detailViewCount ?? 0)],
      ["downloads", String(share.analytics?.downloadCount ?? 0)],
      [
        "downloadsByFile",
        Object.entries(share.analytics?.downloadsByFile ?? {})
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([file, count]) => `${file}×${count}`)
          .join(", ") || "n/a"
      ],
      [
        "downloadsByMinute",
        (share.analytics?.downloadsByMinute ?? [])
          .slice(-5)
          .map((bucket) => `${bucket.minute.slice(11, 16)}×${bucket.count}`)
          .join(", ") || "n/a"
      ],
      [
        "detailViewsByMinute",
        (share.analytics?.detailViewsByMinute ?? [])
          .slice(-5)
          .map((bucket) => `${bucket.minute.slice(11, 16)}×${bucket.count}`)
          .join(", ") || "n/a"
      ],
      ["lastDownloadedFile", share.analytics?.lastDownloadedFile ?? "n/a"],
      [
        "packDensity",
        formatPackCommitDensity({
          nativeSteps: share.packDensity?.nativeSteps,
          committedSteps: share.packDensity?.committedSteps,
          rejectedSteps: share.packDensity?.rejectedSteps
        })
      ],
      ["detail", share.urls?.detail ?? "n/a"],
      ["filesBase", share.urls?.filesBase ?? "n/a"]
    ],
    json: share
  };
}

export function inspectorFromWarning(warning: HarnessEvaluationWarning): InspectorItem {
  return {
    kind: "evaluation-warning",
    title: warning.code,
    subtitle: warning.severity,
    fields: [
      ["metric", warning.metricId ?? "n/a"],
      ["subject", warning.subjectId ?? "n/a"],
      ["message", warning.message],
      ["evidence", warning.evidenceRefs?.length ?? 0]
    ],
    json: warning
  };
}

export function inspectorFromComparison(comparison: MatchComparisonArtifact): InspectorItem {
  return {
    kind: "match-comparison",
    title: `Match comparison ${shortId(comparison.comparisonId)}`,
    subtitle: `${comparison.artifactVersion} · ${comparison.view}`,
    fields: [
      ["comparisonId", comparison.comparisonId],
      ["view", comparison.view],
      ["createdAt", comparison.createdAt],
      ["baseline", comparison.baseline.matchId ?? comparison.baseline.runId],
      ["candidate", comparison.candidate.matchId ?? comparison.candidate.runId],
      ["rows", comparison.summary.rowCount],
      ["changed rows", comparison.summary.changedRowCount],
      ["numeric deltas", comparison.summary.numericDeltaCount],
      ["promotion changed metrics", comparison.summary.promotionChangedMetricCount],
      ["promotion provenance changed metrics", comparison.summary.promotionProvenanceChangedMetricCount ?? 0],
      ["scorecard metric delta", comparison.summary.scorecardMetricDelta],
      ["diagnostic metric delta", comparison.summary.diagnosticMetricDelta],
      ["benchmark_only metric delta", comparison.summary.benchmarkOnlyMetricDelta],
      ["social steps delta", comparison.summary.socialStepsDelta],
      ["committed steps delta", comparison.summary.committedStepsDelta],
      ["rejected steps delta", comparison.summary.rejectedStepsDelta],
      [
        "baseline steps",
        `s${comparison.summary.baselineSocialSteps}/c${comparison.summary.baselineCommittedSteps}/r${comparison.summary.baselineRejectedSteps}`
      ],
      [
        "candidate steps",
        `s${comparison.summary.candidateSocialSteps}/c${comparison.summary.candidateCommittedSteps}/r${comparison.summary.candidateRejectedSteps}`
      ],
      ["evidence identity changed metrics", comparison.summary.evidenceIdentityChangedMetricCount],
      ["metric keys", `${comparison.summary.metricKeysEmitted}/${comparison.summary.metricKeysCompared}`],
      ["baselineHash", comparison.summary.baselineHash],
      ["candidateHash", comparison.summary.candidateHash]
    ],
    json: comparison
  };
}

export function inspectorFromFilteredComparison(
  projection: MatchComparisonFilteredProjection
): InspectorItem {
  return {
    kind: "match-comparison-filtered",
    title: `Filtered Comparison ${shortId(projection.sourceComparisonId)}`,
    subtitle: `${projection.artifactVersion} · ${projection.view}`,
    fields: [
      ["source comparison", projection.sourceComparisonId],
      ["baseline", projection.source.baseline.matchId ?? projection.source.baseline.runId],
      ["candidate", projection.source.candidate.matchId ?? projection.source.candidate.runId],
      [
        "filter",
        `${projection.filter.group}/${projection.filter.promotion}/${projection.filter.evidenceIdentity}/${projection.filter.numericDelta}${
          projection.filter.changedOnly ? "/changedOnly" : ""
        }`
      ],
      ["rows", `${projection.summary.rowCount}/${projection.summary.sourceRowCount}`],
      ["changed", `${projection.summary.changedRowCount}/${projection.summary.sourceChangedRowCount}`],
      [
        "groups",
        `summary=${projection.summary.summaryRowCount}, metric=${projection.summary.metricRowCount}, metric_evidence=${projection.summary.metricEvidenceRowCount}`
      ],
      ["numeric delta", projection.summary.numericDeltaCount],
      ["promotion changed metrics", projection.summary.promotionChangedMetricCount],
      ["promotion provenance changed metrics", projection.summary.promotionProvenanceChangedMetricCount],
      ["evidence identity changed metrics", projection.summary.evidenceIdentityChangedMetricCount],
      ["evidence identity only-baseline refs", projection.summary.evidenceIdentityOnlyBaselineRefCount],
      ["evidence identity only-candidate refs", projection.summary.evidenceIdentityOnlyCandidateRefCount],
      ["source social steps delta", projection.source.summary.socialStepsDelta],
      ["source committed steps delta", projection.source.summary.committedStepsDelta],
      ["source rejected steps delta", projection.source.summary.rejectedStepsDelta],
      ["projection", projection.view]
    ],
    json: projection
  };
}


export function inspectorFromComparisonRow(row: MatchComparisonRow): InspectorItem {
  return {
    kind: "comparison-row",
    title: row.label,
    subtitle: row.id,
    fields: [
      ["baseline", row.baseline],
      ["candidate", row.candidate],
      ["delta", row.delta ?? "n/a"],
      ["changed", String(row.changed)],
      ["group", row.group ?? "summary"],
      ["metricId", row.metricId ?? "n/a"],
      ["subjectId", row.subjectId ?? "n/a"],
      [
        "promotion",
        row.promotion ? `${row.promotion.baseline}→${row.promotion.candidate}` : "n/a"
      ],
      [
        "promotion changed fields",
        row.promotion?.details?.changedFields.length ? row.promotion.details.changedFields.join(", ") : "n/a"
      ],
      [
        "promotion decision ids",
        row.promotion?.details
          ? `${row.promotion.details.baseline?.catalogDecisionId ?? "n/a"}→${row.promotion.details.candidate?.catalogDecisionId ?? "n/a"}`
          : "n/a"
      ],
      [
        "promotion scorecard eligibility",
        row.promotion?.details
          ? `${row.promotion.details.baseline?.eligibleForScorecard ? "eligible" : "ineligible"}→${row.promotion.details.candidate?.eligibleForScorecard ? "eligible" : "ineligible"}`
          : "n/a"
      ],
      [
        "evidence refs",
        row.evidence ? `${row.evidence.baselineRefs}→${row.evidence.candidateRefs}` : "n/a"
      ],
      [
        "evidence kinds",
        row.evidence
          ? `${row.evidence.baselineKinds.join(",") || "无"}→${row.evidence.candidateKinds.join(",") || "无"}`
          : "n/a"
      ],
      [
        "evidence ids",
        row.evidence
          ? `${row.evidence.baselineIds.length}→${row.evidence.candidateIds.length}`
          : "n/a"
      ],
      [
        "only baseline evidence ids",
        row.evidence?.onlyBaselineIds.length ? row.evidence.onlyBaselineIds.join("; ") : "n/a"
      ],
      [
        "only candidate evidence ids",
        row.evidence?.onlyCandidateIds.length ? row.evidence.onlyCandidateIds.join("; ") : "n/a"
      ]
    ],
    json: row
  };
}

export function inspectorFromReplay(replay: ReplayResponse): InspectorItem {
  return {
    kind: "replay",
    title: replay.summary?.ok ? "Replay passed" : "Replay failed",
    subtitle: replay.summary?.kind ?? "replay",
    fields: [
      ["ok", String(Boolean(replay.summary?.ok))],
      ["authority", replay.summary?.authority ?? "n/a"],
      ["native steps", replay.summary?.nativeSteps ?? 0],
      ["replayed steps", replay.summary?.replayedSteps ?? 0],
      ["replayed batches", replay.summary?.replayedBatches ?? 0],
      ["rejected skipped", replay.summary?.rejectedSteps ?? 0],
      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
      ["message hash matches", String(replay.summary?.messagesHashMatchesExpected ?? false)],
      ["mismatches", replay.summary?.mismatchCount ?? 0],
      ["final hash", replay.summary?.finalHash ?? "n/a"]
    ],
    json: replay
  };
}

export function inspectorFromCheckpoint(checkpoint: CheckpointSummary): InspectorItem {
  return {
    kind: "checkpoint-summary",
    title: `Checkpoint ${shortId(checkpoint.checkpointId)}`,
    subtitle: `${formatDate(checkpoint.createdAt)} · ${checkpoint.reason ?? "no reason"}`,
    fields: [
      ["checkpoint", checkpoint.checkpointId],
      ["source run", checkpoint.source.runId],
      ["source match", checkpoint.source.matchId ?? "n/a"],
      ["trace", checkpoint.source.boundaryTraceRef ?? "initial"],
      ["native turn", checkpoint.source.boundaryTurnIndex ?? "n/a"],
      ["native steps", checkpoint.counts.nativeSteps],
      [
        "committed steps",
        typeof checkpoint.counts.committedSteps === "number" ? checkpoint.counts.committedSteps : "n/a"
      ],
      [
        "rejected steps",
        typeof checkpoint.counts.rejectedSteps === "number" ? checkpoint.counts.rejectedSteps : "n/a"
      ],
      ["messages", checkpoint.counts.socialMessages],
      ["state hash", checkpoint.source.stateHash]
    ],
    json: {
      kind: checkpoint.kind,
      ok: checkpoint.ok,
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      reason: checkpoint.reason ?? null,
      source: checkpoint.source,
      counts: checkpoint.counts
    }
  };
}

export function inspectorFromForkLineage(lineage: ForkLineageSummary): InspectorItem {
  return {
    kind: "fork-lineage",
    title: `Fork Lineage ${shortId(lineage.runId)}`,
    subtitle: `${lineage.isFork ? "fork" : "root"} · ${lineage.boundary?.status ?? "n/a"}`,
    fields: [
      ["run", lineage.runId ?? "n/a"],
      ["match", lineage.matchId ?? "n/a"],
      ["is fork", String(Boolean(lineage.isFork))],
      ["ok", String(Boolean(lineage.ok))],
      ["boundary", lineage.boundary?.status ?? "n/a"],
      ["checkpoint found", String(lineage.boundary?.checkpointFound ?? false)],
      ["state hash match", String(lineage.boundary?.stateHashMatches ?? "n/a")],
      ["message prefix", String(lineage.boundary?.messagePrefixMatchesCheckpoint ?? "n/a")]
    ],
    json: lineage
  };
}

export function inspectorFromBranchTree(tree: BranchTreeSummary): InspectorItem {
  return {
    kind: "checkpoint-branch-tree",
    title: `Branch Tree ${shortId(tree.rootCheckpointId)}`,
    subtitle: `${tree.counts?.checkpoints ?? 0} checkpoints · ${tree.counts?.matches ?? 0} matches`,
    fields: [
      ["root", tree.rootCheckpointId ?? "n/a"],
      ["ok", String(Boolean(tree.ok))],
      ["ok scope", tree.okScope ?? "n/a"],
      ["checkpoints", tree.counts?.checkpoints ?? 0],
      ["matches", tree.counts?.matches ?? 0],
      ["edges", tree.counts?.edges ?? 0],
      ["max depth", tree.counts?.maxDepth ?? 0],
      ["truncated", String(Boolean(tree.truncation?.isTruncated))]
    ],
    json: {
      kind: tree.kind,
      schemaVersion: tree.schemaVersion,
      ok: tree.ok,
      okScope: tree.okScope,
      rootCheckpointId: tree.rootCheckpointId,
      counts: tree.counts,
      truncation: tree.truncation,
      checkpointNodes: tree.checkpoints?.length ?? 0,
      matchNodes: tree.matches?.length ?? 0,
      edges: tree.edges
    }
  };
}

export function safeSocialStepInspectorJson(step: ProjectedSocialStep, index: number): Record<string, unknown> {
  return {
    kind: "native-social-step",
    index,
    traceId: step.traceId,
    turnIndex: step.turnIndex,
    actorId: step.actorId,
    profileId: step.profileId,
    commitStatus: readSocialCommitStatus(step),
    failure: step.failure
      ? {
          stage: step.failure.stage,
          message: step.failure.message,
          causeName: step.failure.causeName
        }
      : step.error
        ? { stage: "legacy_error", message: step.error }
        : null,
    scheduler: {
      mode: step.schedulerMode,
      batchId: step.batchId ?? null,
      batchIndex: step.batchIndex ?? null,
      batchSize: step.batchSize ?? null,
      atomic: step.atomic ?? null,
      resolutionPolicy: step.resolutionPolicy ?? null
    },
    pendingActionKind: readSocialPendingKind(step),
    actionKind: step.action.kind,
    commandType: readSocialCommandType(step),
    hashes: {
      decisionStateHash: step.decisionStateHash,
      preStateHash: step.preStateHash,
      postStateHash: step.postStateHash,
      actorSnapshotsHashAfterStep: step.actorSnapshotsHashAfterStep
    },
    ranges: {
      eventSeqRange: step.eventSeqRange,
      messageSeqRange: step.messageSeqRange
    }
  };
}

export function safeAgentInspectorJson(agent: AgentHarnessState): Record<string, unknown> {
  return {
    kind: "agent",
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName,
    turns: agent.turns,
    observations: agent.observations,
    beliefCount: Object.keys(agent.beliefs ?? {}).length,
    privateMemoCount: agent.privateMemos.length,
    lastIntent: agent.lastIntent,
    socialStateHash: agent.socialStateHash,
    social: {
      relationshipCount: Object.keys(agent.social?.relationships?.edges ?? {}).length,
      journalEntryCount: agent.social?.journal?.entries.length ?? 0,
      memoryCount: agent.social?.memory.entries.length ?? 0,
      reputationCount: Object.keys(agent.social?.reputation.records ?? {}).length,
      normCount: Object.keys(agent.social?.norms.norms ?? {}).length,
      goalCount: agent.social?.goals.goals.length ?? 0
    }
  };
}

export function safeMessageInspectorJson(message: SocialMessage): Record<string, unknown> {
  return {
    kind: "social-message",
    id: message.id,
    seq: message.seq,
    channelId: message.channelId,
    senderId: message.senderId,
    recipientIds: message.recipientIds,
    visibility: message.visibility,
    content: message.content,
    createdAt: message.createdAt,
    speechActCount: message.speechActs?.length ?? 0,
    speechActKinds: uniqueStrings((message.speechActs ?? []).map((act) => act.kind)),
    deliveryReceiptCount: message.deliveryReceipts?.length ?? 0,
    receiptRedactionPolicies: uniqueStrings((message.deliveryReceipts ?? []).map((receipt) => receipt.redactionPolicy)),
    metadata: message.metadata
  };
}
