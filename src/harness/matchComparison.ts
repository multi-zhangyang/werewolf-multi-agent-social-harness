import type { MatchMetrics } from "../core/types";
import type { MatchArtifact } from "./artifacts";
import { hashStableState } from "./hash";
import { deriveSocialExposureRecords } from "./social";

export const MATCH_COMPARISON_ARTIFACT_VERSION = "harness.match-comparison.v1";

export type MatchComparisonView = "full" | "postgame-redacted";
export type MatchComparisonValue = string | number | boolean | null;

export interface MatchComparisonProjection {
  view: MatchComparisonView;
  privateEvidenceRedacted: boolean;
  postgameTruthRedacted: boolean;
  generatedAt: string;
}

export interface MatchComparisonSourceSummary {
  matchId?: string;
  runId: string;
  seed: string;
  createdAt: string;
  status: MatchArtifact["status"];
  truncationReason?: string;
  failureReason?: string;
  projection?: MatchComparisonProjection;
  models: string[];
  profileCount: number;
  resolvedAssignmentCount: number;
  agentCount: number;
  trajectorySteps: number;
  socialSteps: number;
  socialMessages: number;
  socialSpeechActs: number;
  socialDeliveryReceipts: number;
  socialChannels: number;
  gameEvents: number;
  evaluationMetricCount: number;
  evaluationWarningCount: number;
  evaluatorCount: number;
  stateHash: string;
  artifactHash: string;
}

export interface MatchComparisonRow {
  id: string;
  label: string;
  baseline: MatchComparisonValue;
  candidate: MatchComparisonValue;
  delta?: number;
  changed: boolean;
}

export interface MatchComparisonArtifact {
  artifactVersion: typeof MATCH_COMPARISON_ARTIFACT_VERSION;
  kind: "match-comparison";
  comparisonId: string;
  createdAt: string;
  view: MatchComparisonView;
  projection: MatchComparisonProjection;
  baseline: MatchComparisonSourceSummary;
  candidate: MatchComparisonSourceSummary;
  rows: MatchComparisonRow[];
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount: number;
    baselineHash: string;
    candidateHash: string;
  };
}

export function buildMatchComparisonArtifact(options: {
  baseline: MatchArtifact;
  candidate: MatchArtifact;
  view: MatchComparisonView;
  createdAt?: string;
}): MatchComparisonArtifact {
  const baseline = options.baseline;
  const candidate = options.candidate;
  const rows = buildComparisonRows(baseline, candidate);
  const baselineHash = hashStableState(baseline);
  const candidateHash = hashStableState(candidate);
  const comparisonId = comparisonArtifactId({
    view: options.view,
    baselineRunId: baseline.runId,
    baselineMatchId: baseline.matchId,
    candidateRunId: candidate.runId,
    candidateMatchId: candidate.matchId,
    baselineHash,
    candidateHash
  });
  return {
    artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
    kind: "match-comparison",
    comparisonId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    view: options.view,
    projection: {
      view: options.view,
      privateEvidenceRedacted: sourceProjection(baseline)?.privateEvidenceRedacted ?? options.view === "postgame-redacted",
      postgameTruthRedacted: sourceProjection(baseline)?.postgameTruthRedacted ?? false,
      generatedAt: sourceProjection(baseline)?.generatedAt ?? new Date(0).toISOString()
    },
    baseline: summarizeSource(baseline, baselineHash),
    candidate: summarizeSource(candidate, candidateHash),
    rows,
    summary: {
      rowCount: rows.length,
      changedRowCount: rows.filter((row) => row.changed).length,
      numericDeltaCount: rows.filter((row) => row.delta !== undefined).length,
      baselineHash,
      candidateHash
    }
  };
}

function buildComparisonRows(baseline: MatchArtifact, candidate: MatchArtifact): MatchComparisonRow[] {
  const baselineUsage = summarizeModelUsage(baseline.metrics.modelUsage);
  const candidateUsage = summarizeModelUsage(candidate.metrics.modelUsage);
  return [
    stringRow("status", "状态", baseline.status, candidate.status),
    stringRow("winner", "胜者", baseline.finalState.winner ?? baseline.metrics.winner ?? "未结束", candidate.finalState.winner ?? candidate.metrics.winner ?? "未结束"),
    stringRow("truncation_reason", "截断原因", baseline.truncationReason ?? "无", candidate.truncationReason ?? "无"),
    stringRow("failure_reason", "失败原因", baseline.failureReason ?? "无", candidate.failureReason ?? "无"),
    stringRow("models", "模型", baseline.models.join(", ") || "暂无", candidate.models.join(", ") || "暂无"),
    stringRow("social_scheduler", "社会调度器", baseline.socialEpisode.schedulerMode, candidate.socialEpisode.schedulerMode),
    numberRow("trajectory_steps", "轨迹步数", baseline.trajectory.length, candidate.trajectory.length),
    numberRow("social_steps", "社会调度步", baseline.socialEpisode.steps.length, candidate.socialEpisode.steps.length),
    numberRow("social_messages", "社会消息", baseline.socialEpisode.messages.length, candidate.socialEpisode.messages.length),
    numberRow("social_speech_acts", "社会言语行为", countSocialSpeechActs(baseline), countSocialSpeechActs(candidate)),
    numberRow("social_delivery_receipts", "消息投递凭证", countSocialDeliveryReceipts(baseline), countSocialDeliveryReceipts(candidate)),
    numberRow("social_channels", "通信通道", baseline.socialEpisode.channels.length, candidate.socialEpisode.channels.length),
    numberRow("profiles", "profiles", baseline.profiles.length, candidate.profiles.length),
    numberRow("resolved_assignments", "resolved assignments", baseline.resolvedAssignments.length, candidate.resolvedAssignments.length),
    numberRow("agents", "智能体状态", baseline.agents.length, candidate.agents.length),
    numberRow("game_events", "游戏事件", baseline.finalState.events.length, candidate.finalState.events.length),
    numberRow("days", "天数", baseline.metrics.days, candidate.metrics.days),
    numberRow("deaths", "死亡", baseline.metrics.totalDeaths, candidate.metrics.totalDeaths),
    numberRow("speeches", "发言", baseline.metrics.totalSpeeches, candidate.metrics.totalSpeeches),
    numberRow("votes", "投票", baseline.metrics.totalVotes, candidate.metrics.totalVotes),
    numberRow("harness_turns", "harness turn", baseline.metrics.harnessTurnCount, candidate.metrics.harnessTurnCount),
    numberRow("harness_errors", "harness error", baseline.metrics.harnessErrorCount, candidate.metrics.harnessErrorCount),
    numberRow("average_latency_ms", "平均模型延迟(ms)", Math.round(baseline.metrics.averageLatencyMs), Math.round(candidate.metrics.averageLatencyMs)),
    numberRow("model_calls", "模型调用", baselineUsage.calls, candidateUsage.calls),
    numberRow("prompt_tokens", "prompt tokens", baselineUsage.promptTokens, candidateUsage.promptTokens),
    numberRow("completion_tokens", "completion tokens", baselineUsage.completionTokens, candidateUsage.completionTokens),
    numberRow("evaluation_metrics", "评测指标", baseline.evaluationReport.metricCount, candidate.evaluationReport.metricCount),
    numberRow("evaluation_warnings", "评测告警", baseline.evaluationReport.warnings?.length ?? 0, candidate.evaluationReport.warnings?.length ?? 0),
    numberRow("evaluators", "evaluator 数", baseline.evaluationReport.evaluatorIds.length, candidate.evaluationReport.evaluatorIds.length),
    numberRow("social_exposures", "观察暴露记录", countSocialExposureRecords(baseline), countSocialExposureRecords(candidate)),
    numberRow("relationship_edges", "关系边", countRelationshipEdges(baseline), countRelationshipEdges(candidate)),
    numberRow("reputation_edges", "声誉边", countReputationEdges(baseline), countReputationEdges(candidate))
  ];
}

function summarizeSource(artifact: MatchArtifact, artifactHash: string): MatchComparisonSourceSummary {
  return {
    matchId: artifact.matchId,
    runId: artifact.runId,
    seed: artifact.seed,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason,
    failureReason: artifact.failureReason,
    projection: sourceProjection(artifact),
    models: [...artifact.models],
    profileCount: artifact.profiles.length,
    resolvedAssignmentCount: artifact.resolvedAssignments.length,
    agentCount: artifact.agents.length,
    trajectorySteps: artifact.trajectory.length,
    socialSteps: artifact.socialEpisode.steps.length,
    socialMessages: artifact.socialEpisode.messages.length,
    socialSpeechActs: countSocialSpeechActs(artifact),
    socialDeliveryReceipts: countSocialDeliveryReceipts(artifact),
    socialChannels: artifact.socialEpisode.channels.length,
    gameEvents: artifact.finalState.events.length,
    evaluationMetricCount: artifact.evaluationReport.metricCount,
    evaluationWarningCount: artifact.evaluationReport.warnings?.length ?? 0,
    evaluatorCount: artifact.evaluationReport.evaluatorIds.length,
    stateHash: hashStableState(artifact.finalState),
    artifactHash
  };
}

function numberRow(id: string, label: string, baseline: number, candidate: number): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    delta: candidate - baseline,
    changed: baseline !== candidate
  };
}

function stringRow(id: string, label: string, baseline: string, candidate: string): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    changed: baseline !== candidate
  };
}

function summarizeModelUsage(usage: MatchMetrics["modelUsage"]): { calls: number; promptTokens: number; completionTokens: number; latencyMs: number } {
  return Object.values(usage).reduce(
    (summary, item) => ({
      calls: summary.calls + item.calls,
      promptTokens: summary.promptTokens + item.promptTokens,
      completionTokens: summary.completionTokens + item.completionTokens,
      latencyMs: summary.latencyMs + item.latencyMs
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 }
  );
}

function countRelationshipEdges(artifact: MatchArtifact): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.relationships.edges ?? {}).length, 0);
}

function countReputationEdges(artifact: MatchArtifact): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.reputation.records ?? {}).length, 0);
}

function countSocialSpeechActs(artifact: MatchArtifact): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.speechActs?.length ?? 0), 0);
}

function countSocialDeliveryReceipts(artifact: MatchArtifact): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.deliveryReceipts?.length ?? 0), 0);
}

function countSocialExposureRecords(artifact: MatchArtifact): number {
  if (sourceProjection(artifact)?.view === "postgame-redacted" && Array.isArray(artifact.socialEpisode.exposureRecords)) {
    return artifact.socialEpisode.exposureRecords.length;
  }
  return deriveSocialExposureRecords(artifact.socialEpisode).length;
}

function sourceProjection(artifact: MatchArtifact): MatchComparisonProjection | undefined {
  const projection = (artifact as MatchArtifact & { projection?: MatchComparisonProjection }).projection;
  return projection ? { ...projection } : undefined;
}

function comparisonArtifactId(input: {
  view: MatchComparisonView;
  baselineRunId: string;
  baselineMatchId?: string;
  candidateRunId: string;
  candidateMatchId?: string;
  baselineHash: string;
  candidateHash: string;
}): string {
  return `match-comparison:${hashStableState(input).slice(0, 24)}`;
}
