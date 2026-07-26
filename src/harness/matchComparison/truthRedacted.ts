import { finiteNumber, numberRow, recordOf, recordsOf, sortComparisonRows, stringRow, stringValue } from "./comparisonRows";
import { comparisonArtifactId } from "./metricEvidence";
import { hashStableState } from "../hash";
import { MATCH_COMPARISON_ARTIFACT_VERSION, MATCH_COMPARISON_MAX_METRIC_ROWS, MatchComparisonArtifact, MatchComparisonInput, MatchComparisonProjection, MatchComparisonSourceSummary, TruthRedactedMatchComparisonSource } from "./artifact";
interface TruthRedactedComparisonSnapshot {
  status: string;
  createdAt?: string;
  phase: string;
  day: number;
  alivePlayers: number;
  publicEvents: Array<{ seq: number | null; day: number | null; type: string }>;
  schedulerMode: string;
  publicChannelCount: number;
  publicMessageCount: number;
  publicSpeechActCount: number;
  projection?: MatchComparisonProjection;
}

/**
 * Public comparisons deliberately operate on a newly narrowed snapshot. This
 * prevents an accidental full artifact input from contributing hidden state
 * merely because a caller requested a truth-redacted view.
 */
export function buildTruthRedactedMatchComparisonArtifact(options: {
  baseline: MatchComparisonInput;
  candidate: MatchComparisonInput;
  view: "truth-redacted";
  createdAt?: string;
}): MatchComparisonArtifact {
  const baseline = truthRedactedComparisonSnapshot(options.baseline);
  const candidate = truthRedactedComparisonSnapshot(options.candidate);
  const baselineHash = hashStableState(truthRedactedComparisonFingerprint(baseline));
  const candidateHash = hashStableState(truthRedactedComparisonFingerprint(candidate));
  const rows = sortComparisonRows([
    stringRow("status", "状态", baseline.status, candidate.status),
    stringRow("phase", "阶段", baseline.phase, candidate.phase),
    stringRow("social_scheduler", "社会调度器", baseline.schedulerMode, candidate.schedulerMode),
    numberRow("day", "天数", baseline.day, candidate.day),
    numberRow("alive_players", "存活玩家", baseline.alivePlayers, candidate.alivePlayers),
    numberRow("public_game_events", "公开游戏事件", baseline.publicEvents.length, candidate.publicEvents.length),
    numberRow("public_social_messages", "公开社会消息", baseline.publicMessageCount, candidate.publicMessageCount),
    numberRow("public_social_speech_acts", "公开言语行为", baseline.publicSpeechActCount, candidate.publicSpeechActCount),
    numberRow("public_social_channels", "公开通信通道", baseline.publicChannelCount, candidate.publicChannelCount)
  ].map((row) => ({ ...row, group: "summary" as const })));
  const projection: MatchComparisonProjection = {
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: baseline.projection?.generatedAt ?? candidate.projection?.generatedAt ?? new Date(0).toISOString()
  };
  const comparisonId = comparisonArtifactId({
    view: "truth-redacted",
    baselineHash,
    candidateHash
  });

  return {
    artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
    kind: "match-comparison",
    comparisonId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    view: "truth-redacted",
    projection,
    baseline: truthRedactedSourceSummary(baseline, baselineHash),
    candidate: truthRedactedSourceSummary(candidate, candidateHash),
    rows,
    summary: {
      rowCount: rows.length,
      changedRowCount: rows.filter((row) => row.changed).length,
      numericDeltaCount: rows.filter((row) => row.delta !== undefined).length,
      promotionChangedMetricCount: 0,
      promotionProvenanceChangedMetricCount: 0,
      scorecardMetricDelta: 0,
      diagnosticMetricDelta: 0,
      benchmarkOnlyMetricDelta: 0,
      metricKeysCompared: 0,
      metricKeysEmitted: 0,
      metricKeysTruncated: 0,
      scorecardMetricKeysCompared: 0,
      scorecardMetricKeysEmitted: 0,
      scorecardMetricKeysTruncated: 0,
      diagnosticMetricKeysCompared: 0,
      diagnosticMetricKeysEmitted: 0,
      diagnosticMetricKeysTruncated: 0,
      benchmarkOnlyMetricKeysCompared: 0,
      benchmarkOnlyMetricKeysEmitted: 0,
      benchmarkOnlyMetricKeysTruncated: 0,
      evidenceIdentityChangedMetricCount: 0,
      evidenceIdentityOnlyBaselineRefCount: 0,
      evidenceIdentityOnlyCandidateRefCount: 0,
      baselineSocialSteps: 0,
      candidateSocialSteps: 0,
      baselineCommittedSteps: 0,
      candidateCommittedSteps: 0,
      baselineRejectedSteps: 0,
      candidateRejectedSteps: 0,
      socialStepsDelta: 0,
      committedStepsDelta: 0,
      rejectedStepsDelta: 0,
      metricRowsMax: MATCH_COMPARISON_MAX_METRIC_ROWS,
      baselineHash,
      candidateHash
    }
  };
}

function truthRedactedComparisonSnapshot(source: MatchComparisonInput): TruthRedactedComparisonSnapshot {
  const redacted = source as TruthRedactedMatchComparisonSource;
  const state = recordOf(redacted.finalState);
  const socialEpisode = recordOf(redacted.socialEpisode);
  const publicChannels = recordsOf(socialEpisode?.channels).filter(
    (channel) => channel.kind === "public" && channel.readableBy === "all"
  );
  const publicChannelIds = new Set(
    publicChannels.flatMap((channel) => (typeof channel.id === "string" ? [channel.id] : []))
  );
  const publicMessages = recordsOf(socialEpisode?.messages).filter(
    (message) => message.visibility === "public" && typeof message.channelId === "string" && publicChannelIds.has(message.channelId)
  );
  const publicEvents = recordsOf(state?.events)
    .filter((event) => event.visibility === "public")
    .map((event) => ({
      seq: finiteNumber(event.seq) ?? null,
      day: finiteNumber(event.day) ?? null,
      type: stringValue(event.type) ?? "unknown"
    }));

  return {
    status: stringValue(redacted.status) ?? "unknown",
    createdAt: stringValue(redacted.createdAt),
    phase: stringValue(state?.phase) ?? "unknown",
    day: finiteNumber(state?.day) ?? 0,
    alivePlayers: recordsOf(state?.players).filter((player) => player.alive === true).length,
    publicEvents,
    schedulerMode: stringValue(socialEpisode?.schedulerMode) ?? "unknown",
    publicChannelCount: publicChannels.length,
    publicMessageCount: publicMessages.length,
    publicSpeechActCount: publicMessages.reduce(
      (count, message) => count + (Array.isArray(message.speechActs) ? message.speechActs.length : 0),
      0
    ),
    projection: redacted.projection
  };
}

function truthRedactedComparisonFingerprint(snapshot: TruthRedactedComparisonSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    phase: snapshot.phase,
    day: snapshot.day,
    alivePlayers: snapshot.alivePlayers,
    publicEvents: snapshot.publicEvents,
    schedulerMode: snapshot.schedulerMode,
    publicChannelCount: snapshot.publicChannelCount,
    publicMessageCount: snapshot.publicMessageCount,
    publicSpeechActCount: snapshot.publicSpeechActCount
  };
}

function truthRedactedSourceSummary(
  snapshot: TruthRedactedComparisonSnapshot,
  artifactHash: string
): MatchComparisonSourceSummary {
  return {
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    projection: snapshot.projection,
    models: [],
    profileCount: 0,
    resolvedAssignmentCount: 0,
    agentCount: 0,
    trajectorySteps: 0,
    socialSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    socialMessages: snapshot.publicMessageCount,
    socialSpeechActs: snapshot.publicSpeechActCount,
    socialDeliveryReceipts: 0,
    socialChannels: snapshot.publicChannelCount,
    gameEvents: snapshot.publicEvents.length,
    evaluationMetricCount: 0,
    evaluationWarningCount: 0,
    evaluatorCount: 0,
    stateHash: hashStableState({
      phase: snapshot.phase,
      day: snapshot.day,
      alivePlayers: snapshot.alivePlayers,
      publicEvents: snapshot.publicEvents
    }),
    artifactHash
  };
}
