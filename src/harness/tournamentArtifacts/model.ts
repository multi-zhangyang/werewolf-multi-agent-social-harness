import { MatchArtifact } from "../artifacts";
import { MetricPromotionPolicy, legacyMetricPromotionPolicyFromSummary, normalizeMetricPromotionSummary } from "../evaluation";
import { NormalizedTournamentExperiment } from "../experiment";
import { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../profiles";
import { TournamentEpisode, TournamentResult } from "../tournament";
import { HarnessEvaluationReport, ProviderFailureSummary } from "../types";
import path from "node:path";
export const TOURNAMENT_ARTIFACT_VERSION = "harness.tournament.v1";
/**
 * Public tournament exports deliberately use a distinct schema.  A
 * truth-redacted match artifact by itself is not enough to make the rest of a
 * tournament bundle safe to publish: the canonical tournament result also
 * contains seeds, profile-to-seat assignments, evaluator evidence, and
 * provider telemetry.
 */
export const PUBLIC_TOURNAMENT_ARTIFACT_VERSION = "harness.tournament.public.v1";
export type TournamentArtifactVisibility = "research-full" | "postgame-research" | "public";
export const BENCHMARK_STATISTICS_VERSION = "harness.benchmark-statistics.v1";
export const BENCHMARK_STATISTICS_EVALUATOR_ID = "evaluation.benchmark-statistics.v1";
export const BENCHMARK_STATISTICS_EVALUATOR_VERSION = "1.0.0";
export const BENCHMARK_STATISTICS_METRIC_IDS = [
  "benchmark.status_denominators",
  "benchmark.agent_seat_strata",
  "benchmark.episode_status_strata",
  "benchmark.harness_status_strata"
];

type MetricPromotionSummary = HarnessEvaluationReport["summary"]["promotion"];

interface MetricPromotionPolicyDescriptor {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
}

export function promotionFallbackPolicyForReport(report: HarnessEvaluationReport | undefined): MetricPromotionPolicy {
  return legacyMetricPromotionPolicyFromSummary(report?.summary.promotion);
}

function primaryMetricPromotionSummary(result: TournamentResult): MetricPromotionSummary | undefined {
  const report = result.episodes.find((episode) => Boolean(episode.evaluationReport))?.evaluationReport;
  return report ? normalizeMetricPromotionSummary(report.summary.promotion) : undefined;
}

export function evaluationCoverageForEpisodes(episodes: readonly TournamentEpisode[]): {
  evaluationReportCount: number;
  evaluationCompletedEpisodes: number;
  evaluationIncompleteEpisodes: number;
  evaluatorFailureCount: number;
} {
  const reports = episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []));
  return {
    evaluationReportCount: reports.length,
    evaluationCompletedEpisodes: reports.filter((report) => (report.status ?? "completed") === "completed").length,
    evaluationIncompleteEpisodes: reports.filter((report) => (report.status ?? "completed") === "incomplete").length,
    evaluatorFailureCount: reports.reduce((sum, report) => sum + (report.failures?.length ?? 0), 0)
  };
}

function metricPromotionCatalogDescriptor(summary: MetricPromotionSummary): {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
  entryCount: number;
  ruleCount: number;
  ruleIds: string[];
  scorecardMetricIds: string[];
  diagnosticMetricIds: string[];
  benchmarkOnlyMetricIds: string[];
} {
  return {
    catalogId: summary.catalogId,
    catalogVersion: summary.catalogVersion,
    catalogHash: summary.catalogHash,
    catalogDomainId: summary.catalogDomainId,
    entryCount: summary.catalogEntryCount,
    ruleCount: summary.catalogRuleCount,
    ruleIds: [...summary.catalogRuleIds],
    scorecardMetricIds: [...summary.catalogScorecardMetricIds],
    diagnosticMetricIds: [...summary.catalogDiagnosticMetricIds],
    benchmarkOnlyMetricIds: [...summary.catalogBenchmarkOnlyMetricIds]
  };
}

function metricPromotionPolicyDescriptor(summary: MetricPromotionSummary): MetricPromotionPolicyDescriptor {
  return {
    policyId: summary.policyId,
    policyVersion: summary.policyVersion,
    policyHash: summary.policyHash,
    catalogId: summary.catalogId,
    catalogVersion: summary.catalogVersion,
    catalogHash: summary.catalogHash,
    catalogDomainId: summary.catalogDomainId
  };
}

function metricPromotionPolicyDescriptors(result: TournamentResult): MetricPromotionPolicyDescriptor[] {
  const descriptors = new Map<string, MetricPromotionPolicyDescriptor>();
  for (const episode of result.episodes) {
    if (!episode.evaluationReport) continue;
    const summary = normalizeMetricPromotionSummary(episode.evaluationReport.summary.promotion);
    const descriptor = metricPromotionPolicyDescriptor(summary);
    const key = [
      descriptor.policyId,
      descriptor.policyVersion,
      descriptor.policyHash,
      descriptor.catalogId,
      descriptor.catalogVersion,
      descriptor.catalogHash,
      descriptor.catalogDomainId
    ].join("|");
    descriptors.set(key, descriptor);
  }
  return [...descriptors.values()].sort(
    (left, right) =>
      left.policyId.localeCompare(right.policyId) ||
      left.policyVersion.localeCompare(right.policyVersion) ||
      left.catalogId.localeCompare(right.catalogId) ||
      left.catalogVersion.localeCompare(right.catalogVersion) ||
      left.catalogHash.localeCompare(right.catalogHash)
  );
}

export function metricPromotionExportMetadata(result: TournamentResult): {
  metricPromotionPolicyId: string | null;
  metricPromotionPolicyVersion: string | null;
  metricPromotionPolicyHash: string | null;
  metricPromotionCatalogId: string | null;
  metricPromotionCatalogVersion: string | null;
  metricPromotionCatalogHash: string | null;
  metricPromotionCatalogDomainId: string | null;
  metricPromotionCatalog: ReturnType<typeof metricPromotionCatalogDescriptor> | null;
  metricPromotionPolicies: MetricPromotionPolicyDescriptor[];
  mixedMetricPromotionPolicies: boolean;
} {
  const policies = metricPromotionPolicyDescriptors(result);
  // A tournament-wide singular descriptor is honest only when every report
  // resolves to the same policy/catalog identity. Mixed runs retain their
  // complete descriptor list rather than inheriting an arbitrary first report.
  const summary = policies.length === 1 ? primaryMetricPromotionSummary(result) : undefined;
  if (!summary || policies.length !== 1) {
    return {
      metricPromotionPolicyId: null,
      metricPromotionPolicyVersion: null,
      metricPromotionPolicyHash: null,
      metricPromotionCatalogId: null,
      metricPromotionCatalogVersion: null,
      metricPromotionCatalogHash: null,
      metricPromotionCatalogDomainId: null,
      metricPromotionCatalog: null,
      metricPromotionPolicies: policies,
      mixedMetricPromotionPolicies: policies.length > 1
    };
  }
  return {
    metricPromotionPolicyId: summary.policyId,
    metricPromotionPolicyVersion: summary.policyVersion,
    metricPromotionPolicyHash: summary.policyHash,
    metricPromotionCatalogId: summary.catalogId,
    metricPromotionCatalogVersion: summary.catalogVersion,
    metricPromotionCatalogHash: summary.catalogHash,
    metricPromotionCatalogDomainId: summary.catalogDomainId,
    metricPromotionCatalog: metricPromotionCatalogDescriptor(summary),
    metricPromotionPolicies: policies,
    mixedMetricPromotionPolicies: policies.length > 1
  };
}

export interface TournamentArtifactWriteOptions {
  outputDir: string;
  experimentId?: string;
  createdAt?: string;
  overwrite?: boolean;
  /**
   * Optional match-artifact projector for public/share packs.
   * Research exports leave this undefined and write full match artifacts.
   */
  projectMatchArtifact?: (artifact: MatchArtifact) => unknown;
  /**
   * Domain-owned projection used only for the strict public pack.  It must
   * construct a public observation DTO directly; passing a broad MatchArtifact
   * through a redactor is deliberately not sufficient here.
   */
  projectPublicMatchArtifact?: (artifact: MatchArtifact, episodeIndex: number) => unknown;
  /**
   * When true, strip seat role/team truth from assignment exports.
   * Use with projectMatchArtifact for untrusted public packs.
   */
  redactAssignmentTruth?: boolean;
  /**
   * Declared projection label recorded in manifest.files/projection metadata.
   */
  matchArtifactView?: "full" | "postgame-redacted" | "truth-redacted";
  /**
   * `public` is a separate allowlist schema, not a label placed on a
   * partially-redacted research export.  Only it may be shared through the
   * unauthenticated public-share API.
   */
  visibility?: TournamentArtifactVisibility;
}

export interface TournamentArtifactFileBase {
  manifest: string;
  matchesDir: string;
  matches: string[];
}

export interface ResearchTournamentArtifactFiles extends TournamentArtifactFileBase {
  registry: string;
  specNormalized: string;
  assignment: string;
  episodes: string;
  trajectory: string;
  metrics: string;
  integrity: string;
  failures: string;
  costLatency: string;
  leaderboard: string;
  benchmarkStatistics: string;
  tournamentComparison: string;
  tournamentComparisonMarkdown: string;
  summaryMarkdown: string;
  episodesCsv: string;
  agentsCsv: string;
  metricsCsv: string;
  leaderboardCsv: string;
  matchesJsonl: string[];
}

export interface PublicTournamentArtifactFiles extends TournamentArtifactFileBase {
  episodes: string;
}

export type TournamentArtifactFiles = ResearchTournamentArtifactFiles | PublicTournamentArtifactFiles;

export interface TournamentArtifactWriteResult<TFiles extends TournamentArtifactFiles = TournamentArtifactFiles> {
  outputDir: string;
  files: TFiles;
}

export interface PublicTournamentArtifactWriteOptions extends TournamentArtifactWriteOptions {
  visibility: "public";
  projectPublicMatchArtifact: (artifact: MatchArtifact, episodeIndex: number) => unknown;
}

export type ResearchTournamentArtifactWriteOptions = TournamentArtifactWriteOptions & {
  visibility?: Exclude<TournamentArtifactVisibility, "public">;
};

function isResearchTournamentArtifactFiles(files: TournamentArtifactFiles): files is ResearchTournamentArtifactFiles {
  return "registry" in files;
}

export interface PublicTournamentMatchRecord {
  episodeIndex: number;
  projectedArtifact: Record<string, unknown>;
  relativePath: string;
  relativeJsonlPath: string;
  status: string;
  harnessStatus: string | null;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  publicMessageCount: number;
  playerCount: number;
}

export function tournamentArtifactVisibilityForOptions(options: TournamentArtifactWriteOptions): TournamentArtifactVisibility {
  if (options.visibility) return options.visibility;
  // A caller can still request a redacted research export for trusted review,
  // but it must not acquire public-share authority merely by setting two
  // booleans from the legacy API.
  return options.projectMatchArtifact ? "postgame-research" : "research-full";
}

export function tournamentArtifactFilePaths(outputDir: string): ResearchTournamentArtifactFiles {
  return {
    manifest: path.join(outputDir, "manifest.json"),
    registry: path.join(outputDir, "registry.json"),
    specNormalized: path.join(outputDir, "spec.normalized.json"),
    assignment: path.join(outputDir, "assignment.json"),
    episodes: path.join(outputDir, "episodes.jsonl"),
    trajectory: path.join(outputDir, "trajectory.jsonl"),
    metrics: path.join(outputDir, "metrics.jsonl"),
    integrity: path.join(outputDir, "integrity.jsonl"),
    failures: path.join(outputDir, "failures.jsonl"),
    costLatency: path.join(outputDir, "cost_latency.json"),
    leaderboard: path.join(outputDir, "leaderboard.json"),
    benchmarkStatistics: path.join(outputDir, "benchmark_statistics.json"),
    tournamentComparison: path.join(outputDir, "tournament_comparison.json"),
    tournamentComparisonMarkdown: path.join(outputDir, "tournament_comparison.md"),
    summaryMarkdown: path.join(outputDir, "summary.md"),
    episodesCsv: path.join(outputDir, "episodes.csv"),
    agentsCsv: path.join(outputDir, "agents.csv"),
    metricsCsv: path.join(outputDir, "metrics.csv"),
    leaderboardCsv: path.join(outputDir, "leaderboard.csv"),
    matchesDir: path.join(outputDir, "matches"),
    matches: [],
    matchesJsonl: []
  };
}

export interface TournamentForkSummary {
  checkpointId: string;
  parentRunId: string | null;
  parentMatchId: string | null;
  parentBoundaryTraceId: string | null;
  parentBoundaryTurnIndex: number | null;
  parentStateHash: string;
  parentExecutionPrefixHash: string;
  parentAgentsHash: string;
  parentChannelsHash: string;
  parentMessagesHash: string;
  parentNativeStepCount: number;
  parentMessageCount: number;
  createdAt: string;
  reason: string | null;
}

export type TournamentNormalizedSpecArtifact = NormalizedTournamentExperiment;

export interface TournamentAssignmentArtifact {
  artifactVersion: typeof TOURNAMENT_ARTIFACT_VERSION;
  kind: "tournament-assignment";
  createdAt: string;
  seed: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesFailed: number;
  gamesTruncated: number;
  models: string[];
  profiles: TournamentResult["profiles"];
  assignment: HarnessAssignmentConfig | null;
  episodes: TournamentAssignmentEpisodeRecord[];
}

export interface TournamentAssignmentEpisodeRecord {
  episodeIndex: number;
  tournamentEpisodeIndex: number;
  seed: string;
  runId: string | null;
  matchId: string | null;
  status: TournamentEpisode["status"];
  harnessStatus: MatchArtifact["status"] | null;
  forkOf: TournamentForkSummary | null;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  matchArtifact: string | null;
  matchJsonl: string | null;
  assignment: HarnessAssignmentConfig | null;
  resolvedAssignments: ResolvedAgentAssignment[];
  agents: TournamentAssignmentAgentRecord[];
}

export interface TournamentAssignmentAgentRecord {
  playerId: string;
  seat: number;
  profileId?: string;
  model: string;
  temperature: number | null;
  role?: ResolvedAgentAssignment["role"];
  team?: ResolvedAgentAssignment["team"];
  policyName?: ResolvedAgentAssignment["policyName"];
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}

export interface TournamentFailureAttribution {
  actorId: string | null;
  profileId: string | null;
  model: string | null;
  seat: number | null;
  role: string | null;
  team: string | null;
  policyName: string | null;
  actionKind: string | null;
  traceId: string | null;
  eventId: string | null;
  eventSeq: number | null;
  failureKind: ProviderFailureSummary["failureKind"] | null;
  providerStage: ProviderFailureSummary["providerStage"] | null;
  status: number | null;
  timeoutMs: number | null;
  aborted: boolean | null;
  retryable: boolean | null;
  attempts: number | null;
  maxAttempts: number | null;
  providerFailure: ProviderFailureSummary | null;
  source: "social_step_failure";
}

export interface BenchmarkAgentSeatStratum {
  dimension: "model" | "profile" | "role" | "team" | "seat";
  key: string;
  scheduledSeatCount: number;
  completedSeatCount: number;
  truncatedSeatCount: number;
  failedSeatCount: number;
  completedWithOutcomeCount: number;
  winCount: number;
  rewardCount: number;
  rewardTotal: number;
  averageReward: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  episodeIndexes: number[];
  seeds: string[];
}

export interface BenchmarkEpisodeStratum {
  dimension: "episodeStatus" | "harnessStatus";
  key: string;
  episodeCount: number;
  completedCount: number;
  truncatedCount: number;
  failedCount: number;
  artifactCount: number;
  evaluationCount: number;
  evaluationReportCount: number;
  harnessErrorCount: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  episodeIndexes: number[];
  seeds: string[];
}
