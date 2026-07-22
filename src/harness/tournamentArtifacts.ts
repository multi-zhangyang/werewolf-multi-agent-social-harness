import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProviderFailureKind } from "../agents/schema";
import { toTrajectoryJsonl, validateMatchArtifactIntegrity, type MatchArtifact, type TrajectoryJsonlSource } from "./artifacts";
import { harnessFailureEvidenceFromEpisode } from "./executionEvidence";
import {
  DEFAULT_METRIC_PROMOTION_POLICY,
  legacyMetricPromotionPolicyFromSummary,
  normalizeMetricPromotionSummary,
  resolveRecordedMetricPromotion,
  summarizeEvaluationWarnings,
  type MetricPromotionPolicy
} from "./evaluation";
import type { NormalizedTournamentExperiment } from "./experiment";
import { hashStableState } from "./hash";
import {
  buildTournamentComparisonAggregate,
  formatTournamentComparisonMarkdown,
  type MatchComparisonView,
  type TournamentComparisonAggregate
} from "./matchComparison";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "./profiles";
import type { TournamentEpisode, TournamentMatchArtifactRecord, TournamentResult } from "./tournament";
import type {
  HarnessEvaluationReport,
  HarnessEvaluatorManifestEntry,
  HarnessForkProvenance,
  HarnessMetricRecord,
  ProviderFailureSummary
} from "./types";
import { sanitizePersistedProviderDiagnostics } from "./providerFailure";
import { redactSecrets } from "./redaction";
import { countSocialStepCommits, countSocialStepCommitsByActor, isSocialStepCommitted } from "./social";
import {
  rebuildTournamentLeaderboardFromRawRecords,
  type RebuiltTournamentLeaderboard
} from "./tournamentLeaderboard";
import { werewolfHarnessTurnEvidenceFromEpisode } from "./werewolfExecutionEvidence";
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

function promotionFallbackPolicyForReport(report: HarnessEvaluationReport | undefined): MetricPromotionPolicy {
  return legacyMetricPromotionPolicyFromSummary(report?.summary.promotion);
}

function primaryMetricPromotionSummary(result: TournamentResult): MetricPromotionSummary | undefined {
  const report = result.episodes.find((episode) => Boolean(episode.evaluationReport))?.evaluationReport;
  return report ? normalizeMetricPromotionSummary(report.summary.promotion) : undefined;
}

function evaluationCoverageForEpisodes(episodes: readonly TournamentEpisode[]): {
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

function metricPromotionExportMetadata(result: TournamentResult): {
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

interface PublicTournamentMatchRecord {
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

function tournamentArtifactVisibilityForOptions(options: TournamentArtifactWriteOptions): TournamentArtifactVisibility {
  if (options.visibility) return options.visibility;
  // A caller can still request a redacted research export for trusted review,
  // but it must not acquire public-share authority merely by setting two
  // booleans from the legacy API.
  return options.projectMatchArtifact ? "postgame-research" : "research-full";
}

function tournamentArtifactFilePaths(outputDir: string): ResearchTournamentArtifactFiles {
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

interface BenchmarkAgentSeatStratum {
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

interface BenchmarkEpisodeStratum {
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

export function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: PublicTournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<PublicTournamentArtifactFiles>>;
export function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: ResearchTournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<ResearchTournamentArtifactFiles>>;
export async function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult> {
  const visibility = tournamentArtifactVisibilityForOptions(options);
  if (visibility === "public") {
    return writePublicTournamentArtifactDirectory(result, options);
  }
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const artifactRecords = collectArtifactRecords(result);
  const relativeMatchPaths = new Map<number, string>();
  const relativeMatchJsonlPaths = new Map<number, string>();

  await mkdir(outputDir, { recursive: true });
  const files = tournamentArtifactFilePaths(outputDir);
  await mkdir(files.matchesDir, { recursive: true });

  for (const record of artifactRecords) {
    const stem = safeFileStem(record.matchId ?? record.runId);
    const relativePath = path.join("matches", `${stem}.json`);
    const relativeJsonlPath = path.join("matches", `${stem}.jsonl`);
    const absolutePath = path.join(outputDir, relativePath);
    const absoluteJsonlPath = path.join(outputDir, relativeJsonlPath);
    relativeMatchPaths.set(record.index, relativePath);
    relativeMatchJsonlPaths.set(record.index, relativeJsonlPath);
    files.matches.push(absolutePath);
    files.matchesJsonl.push(absoluteJsonlPath);
    // Research-truth integrity is recorded later via aggregateIntegrityRecords.
    // Public packs may write projected match files that intentionally omit truth.
    const writtenArtifact = options.projectMatchArtifact
      ? options.projectMatchArtifact(record.artifact)
      : record.artifact;
    await writeJson(absolutePath, writtenArtifact, overwrite);
    await writeJsonl(absoluteJsonlPath, trajectoryRecordsFromArtifact(writtenArtifact), overwrite);
  }

  const manifest = buildManifest(result, {
    experimentId: options.experimentId,
    createdAt,
    overwrite,
    artifactRecords,
    relativeMatchPaths,
    relativeMatchJsonlPaths,
    matchArtifactView: options.matchArtifactView ?? (options.projectMatchArtifact ? "truth-redacted" : "full"),
    assignmentTruthRedacted: Boolean(options.redactAssignmentTruth),
    visibility
  });
  const registry = buildRegistrySnapshot(result, createdAt);
  const specNormalized = buildNormalizedSpecExport(result);
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const assignment = buildAssignmentExport(result, {
    createdAt,
    artifactsByIndex,
    relativeMatchPaths,
    relativeMatchJsonlPaths,
    redactAssignmentTruth: options.redactAssignmentTruth
  });
  const episodes = result.episodes.map((episode) =>
    episodeRecord(
      episode,
      relativeMatchPaths.get(episode.index),
      relativeMatchJsonlPaths.get(episode.index),
      artifactsByIndex.get(episode.index),
      Boolean(options.redactAssignmentTruth)
    )
  );
  const trajectory = aggregateTrajectoryRecords(result, artifactRecords, options.projectMatchArtifact);
  const metrics = aggregateMetricRecords(result, Boolean(options.redactAssignmentTruth));
  const integrity = aggregateIntegrityRecords(result, artifactRecords, relativeMatchPaths, relativeMatchJsonlPaths);
  const failures = aggregateFailureRecords(result, artifactRecords, relativeMatchPaths, Boolean(options.redactAssignmentTruth));
  const costLatency = buildCostLatencyReport(result, artifactRecords, createdAt, Boolean(options.redactAssignmentTruth));
  const benchmarkStatistics = buildBenchmarkStatistics(result, createdAt, artifactsByIndex, Boolean(options.redactAssignmentTruth));
  const rebuiltLeaderboard = rebuildTournamentLeaderboardFromRawRecords({
    models: result.models,
    profiles: result.profiles,
    episodeRecords: episodes,
    metricRecords: metrics,
    costLatencyReport: costLatency
  });
  const leaderboard = buildLeaderboard(
    result,
    createdAt,
    artifactsByIndex,
    benchmarkStatistics,
    rebuiltLeaderboard,
    Boolean(options.redactAssignmentTruth)
  );
  const tournamentComparison = buildTournamentComparisonExport(result, {
    createdAt,
    artifactRecords,
    matchArtifactView: options.matchArtifactView ?? (options.projectMatchArtifact ? "truth-redacted" : "full"),
    projectMatchArtifact: options.projectMatchArtifact
  });
  const summaryMarkdown = buildTournamentSummaryMarkdown(result, {
    createdAt,
    experimentId: options.experimentId ?? result.experiment.id,
    artifactRecords,
    integrity,
    failures,
    rebuiltLeaderboard
  });
  const episodesCsv = buildCsv(
    EPISODE_CSV_HEADERS,
    episodeCsvRows(result, relativeMatchPaths, relativeMatchJsonlPaths, artifactsByIndex, Boolean(options.redactAssignmentTruth))
  );
  const agentsCsv = buildCsv(AGENT_CSV_HEADERS, agentCsvRows(result, artifactsByIndex, Boolean(options.redactAssignmentTruth)));
  const metricsCsv = buildCsv(METRIC_CSV_HEADERS, metricCsvRows(result, Boolean(options.redactAssignmentTruth)));
  const leaderboardCsv = buildCsv(
    LEADERBOARD_CSV_HEADERS,
    leaderboardCsvRows(rebuiltLeaderboard, Boolean(options.redactAssignmentTruth))
  );
  await writeJson(files.manifest, manifest, overwrite);
  await writeJson(files.registry, registry, overwrite);
  await writeJson(files.specNormalized, specNormalized, overwrite);
  await writeJson(files.assignment, assignment, overwrite);
  await writeJsonl(files.episodes, episodes, overwrite);
  await writeJsonl(files.trajectory, trajectory, overwrite);
  await writeJsonl(files.metrics, metrics, overwrite);
  await writeJsonl(files.integrity, integrity, overwrite);
  await writeJsonl(files.failures, failures, overwrite);
  await writeJson(files.costLatency, costLatency, overwrite);
  await writeJson(files.benchmarkStatistics, benchmarkStatistics, overwrite);
  await writeJson(files.leaderboard, leaderboard, overwrite);
  await writeJson(files.tournamentComparison, tournamentComparison, overwrite);
  await writeText(files.tournamentComparisonMarkdown, formatTournamentComparisonMarkdown(tournamentComparison), overwrite);
  await writeText(files.summaryMarkdown, summaryMarkdown, overwrite);
  await writeText(files.episodesCsv, episodesCsv, overwrite);
  await writeText(files.agentsCsv, agentsCsv, overwrite);
  await writeText(files.metricsCsv, metricsCsv, overwrite);
  await writeText(files.leaderboardCsv, leaderboardCsv, overwrite);

  return filesResult(outputDir, files);
}

/**
 * The public publication boundary is intentionally tiny.  These files are
 * display artifacts, never replay, evaluation, or control-plane authority:
 *
 * - manifest.json: publication metadata and a fixed file allowlist
 * - episodes.jsonl: public episode index records
 * - matches/episode-N.json: a domain-owned public observation DTO
 */
async function writePublicTournamentArtifactDirectory(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<PublicTournamentArtifactFiles>> {
  if (!options.projectPublicMatchArtifact) {
    throw new Error("Public tournament artifacts require a domain-owned public match artifact projector.");
  }
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const files: PublicTournamentArtifactFiles = {
    manifest: path.join(outputDir, "manifest.json"),
    episodes: path.join(outputDir, "episodes.jsonl"),
    matchesDir: path.join(outputDir, "matches"),
    matches: []
  };
  const publicMatches: PublicTournamentMatchRecord[] = [];

  for (const record of collectArtifactRecords(result)) {
    const relativePath = path.join("matches", `episode-${record.index + 1}.json`);
    const projected = options.projectPublicMatchArtifact(record.artifact, record.index);
    assertPublicTournamentMatchArtifact(projected);
    const artifact = projected as Record<string, unknown>;
    if (artifact.episodeIndex !== record.index) {
      throw new Error("Public match projector returned an artifact for the wrong tournament episode.");
    }
    publicMatches.push({
      episodeIndex: record.index,
      projectedArtifact: artifact,
      relativePath,
      relativeJsonlPath: "",
      status: typeof artifact.status === "string" ? artifact.status : "unknown",
      harnessStatus: null,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      publicMessageCount: publicMessageCount(artifact),
      playerCount: publicPlayerCount(artifact)
    });
  }

  const episodes = publicMatches.map((match) => ({
    kind: "public-episode",
    episodeIndex: match.episodeIndex,
    status: match.status,
    match: match.relativePath,
    publicMessageCount: match.publicMessageCount
  }));
  const manifest = {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament",
    visibility: "public",
    createdAt,
    games: {
      requested: result.gamesRequested,
      completed: result.gamesCompleted,
      failed: result.gamesFailed,
      truncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length
    },
    files: {
      manifest: "manifest.json",
      episodes: "episodes.jsonl",
      matches: publicMatches.map((match) => match.relativePath)
    }
  };

  await mkdir(outputDir, { recursive: true });
  await mkdir(files.matchesDir, { recursive: true });
  for (const match of publicMatches) {
    const absolutePath = path.join(outputDir, match.relativePath);
    files.matches.push(absolutePath);
    await writeJson(absolutePath, match.projectedArtifact, overwrite);
  }
  await writeJson(files.manifest, manifest, overwrite);
  await writeJsonl(files.episodes, episodes, overwrite);
  return filesResult(outputDir, files);
}

export function assertPublicTournamentMatchArtifact(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Public match projector returned a non-object artifact.");
  const keys = Object.keys(value).sort();
  const expected = ["artifactVersion", "episodeIndex", "events", "kind", "messages", "state", "status"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Public match projector returned fields outside the public match schema.");
  }
  if (value.artifactVersion !== "harness.match.public.v1" || value.kind !== "public-match") {
    throw new Error("Public match projector returned an unknown public match schema.");
  }
  if (!Number.isInteger(value.episodeIndex) || typeof value.status !== "string") {
    throw new Error("Public match projector returned an invalid public match identity.");
  }
  if (!isPublicMatchState(value.state) || !Array.isArray(value.events) || !Array.isArray(value.messages)) {
    throw new Error("Public match projector returned an invalid public observation.");
  }
  if (!value.events.every(isPublicMatchEvent) || !value.messages.every(isPublicMatchMessage)) {
    throw new Error("Public match projector retained private event or message topology.");
  }
}

function isPublicMatchState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = ["currentSpeakerSeat", "day", "pendingActionCount", "phase", "players", "publicEventCount"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    typeof value.phase !== "string" ||
    !isNonNegativeInteger(value.day) ||
    !isNonNegativeInteger(value.pendingActionCount) ||
    !isNonNegativeInteger(value.publicEventCount) ||
    (value.currentSpeakerSeat !== undefined && !isNonNegativeInteger(value.currentSpeakerSeat)) ||
    !Array.isArray(value.players)
  ) {
    return false;
  }
  return value.players.every(isPublicMatchPlayer);
}

function isPublicMatchPlayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = ["alive", "eliminatedAt", "isSheriff", "name", "seat"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    !isNonNegativeInteger(value.seat) ||
    typeof value.name !== "string" ||
    typeof value.alive !== "boolean" ||
    typeof value.isSheriff !== "boolean"
  ) {
    return false;
  }
  if (value.eliminatedAt === undefined) return true;
  if (!isRecord(value.eliminatedAt)) return false;
  const eliminatedAtKeys = Object.keys(value.eliminatedAt).sort();
  const expected = ["day", "reason"];
  return (
    eliminatedAtKeys.length === expected.length &&
    eliminatedAtKeys.every((key, index) => key === expected[index]) &&
    isNonNegativeInteger(value.eliminatedAt.day) &&
    typeof value.eliminatedAt.reason === "string"
  );
}

function isPublicMatchEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["day", "seq", "type"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    isNonNegativeInteger(value.seq) &&
    isNonNegativeInteger(value.day) &&
    typeof value.type === "string"
  );
}

function isPublicMatchMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["content", "senderSeat", "seq"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    typeof value.content === "string" &&
    (isNonNegativeInteger(value.senderSeat) || value.senderSeat === null) &&
    isNonNegativeInteger(value.seq)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function publicMessageCount(artifact: Record<string, unknown>): number {
  return Array.isArray(artifact.messages) ? artifact.messages.length : 0;
}

function publicPlayerCount(artifact: Record<string, unknown>): number {
  const state = artifact.state;
  return isRecord(state) && Array.isArray(state.players) ? state.players.length : 0;
}

function publicStepTotals(result: TournamentResult, artifactsByIndex: Map<number, MatchArtifact>): {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
} {
  return result.episodes.reduce(
    (totals, episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const counts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      totals.nativeSteps += counts.nativeSteps;
      totals.committedSteps += counts.committedSteps;
      totals.rejectedSteps += counts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
}

function publicModelAliasMap(result: TournamentResult): Map<string, string> {
  const models = Array.from(new Set([...result.models, ...Object.keys(result.modelStats)])).sort((left, right) => left.localeCompare(right));
  return new Map(models.map((model, index) => [model, `model-${index + 1}`]));
}

function publicEpisodeRecords(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Array<Record<string, unknown>> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return result.episodes.map((episode) => {
    const match = matchesByIndex.get(episode.index);
    const promotion = summarizeTournamentMetricPromotionsFromMetrics(
      episode.evaluationReport?.metrics ?? [],
      promotionFallbackPolicyForReport(episode.evaluationReport)
    );
    return {
      type: "public_episode",
      episodeIndex: episode.index,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? match?.harnessStatus ?? null,
      phase: publicStateString(match?.projectedArtifact, "phase"),
      day: publicStateNumber(match?.projectedArtifact, "day"),
      nativeSteps: match?.nativeSteps ?? 0,
      committedSteps: match?.committedSteps ?? 0,
      rejectedSteps: match?.rejectedSteps ?? 0,
      publicMessageCount: match?.publicMessageCount ?? 0,
      playerCount: match?.playerCount ?? episode.agents.length,
      metricCount: episode.evaluationReport?.metricCount ?? promotion.metricCount,
      scorecardEligibleMetricCount: promotion.scorecardEligibleCount,
      metricPromotionClassCounts: promotion.byClass,
      scorecardEligibleMetricClassCounts: promotion.scorecardEligibleByClass,
      evaluationWarningCount: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCount,
      matchArtifact: match?.relativePath ?? null,
      matchJsonl: match?.relativeJsonlPath ?? null
    };
  });
}

function publicStateString(artifact: Record<string, unknown> | undefined, key: string): string | null {
  const state = artifact && isRecord(artifact.state) ? artifact.state : undefined;
  return state && isRecord(state) ? stringFieldFromRecord(state, key) : null;
}

function publicStateNumber(artifact: Record<string, unknown> | undefined, key: string): number | null {
  const state = artifact && isRecord(artifact.state) ? artifact.state : undefined;
  return state && isRecord(state) ? numericField(state[key]) : null;
}

function publicMetricRecords(summary: ReturnType<typeof summarizeTournamentMetricPromotions>): Array<Record<string, unknown>> {
  return (["scorecard", "diagnostic", "benchmark_only"] as const).map((promotionClass) => ({
    type: "public_metric_summary",
    promotionClass,
    metricCount: summary.byClass[promotionClass],
    scorecardEligibleMetricCount: summary.scorecardEligibleByClass[promotionClass]
  }));
}

function publicFailureRecords(result: TournamentResult, artifactsByIndex: Map<number, MatchArtifact>): Array<Record<string, unknown>> {
  return result.episodes
    .filter((episode) => episode.status === "failed" || episode.harnessStatus === "failed")
    .map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const counts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      const failureKinds: Record<string, number> = {};
      for (const attribution of failureAttributionsForEpisode(episode, artifact, true)) {
        if (attribution.failureKind) increment(failureKinds, attribution.failureKind);
      }
      return {
        type: "public_failure_summary",
        episodeIndex: episode.index,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        failureKindCounts: failureKinds,
        harnessErrorCount: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0,
        nativeSteps: counts.nativeSteps,
        committedSteps: counts.committedSteps,
        rejectedSteps: counts.rejectedSteps
      };
    });
}

function publicCostLatencyReport(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  createdAt: string,
  aliases: Map<string, string>
): Record<string, unknown> {
  const source = buildCostLatencyReport(result, artifactRecords, createdAt, true);
  const sourceRecord = isRecord(source) ? source : {};
  const byModel = isRecord(sourceRecord.byModel) ? sourceRecord.byModel : {};
  const episodes = Array.isArray(sourceRecord.episodes) ? sourceRecord.episodes : [];
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-cost-latency",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    totals: publicCostStats(sourceRecord.totals),
    byModel: Object.fromEntries(
      Object.entries(byModel)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicCostStats(stats)])
    ),
    episodes: episodes.map((episode, index) => {
      const record = isRecord(episode) ? episode : {};
      return {
        episodeIndex: numericField(record.episodeIndex) ?? index,
        status: stringFieldFromRecord(record, "status") ?? "unknown",
        harnessStatus: stringFieldFromRecord(record, "harnessStatus"),
        ...publicCostStats(record)
      };
    })
  };
}

function publicCostStats(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const providerFailures = isRecord(record.providerFailures) ? record.providerFailures : {};
  return {
    calls: numericField(record.calls) ?? 0,
    promptTokens: numericField(record.promptTokens) ?? 0,
    completionTokens: numericField(record.completionTokens) ?? 0,
    totalTokens: numericField(record.totalTokens) ?? 0,
    latencyMs: numericField(record.latencyMs) ?? 0,
    averageLatencyMs: numericField(record.averageLatencyMs) ?? 0,
    harnessTurns: numericField(record.harnessTurns) ?? 0,
    harnessErrors: numericField(record.harnessErrors) ?? 0,
    nativeSteps: numericField(record.nativeSteps) ?? 0,
    committedSteps: numericField(record.committedSteps) ?? 0,
    rejectedSteps: numericField(record.rejectedSteps) ?? 0,
    attempts: publicAttempts(record.attempts),
    providerFailures: {
      count: numericField(providerFailures.count) ?? 0,
      byKind: publicNumberRecord(providerFailures.byKind),
      retryable: numericField(providerFailures.retryable) ?? 0,
      aborted: numericField(providerFailures.aborted) ?? 0,
      timeouts: numericField(providerFailures.timeouts) ?? 0,
      streamAborts: numericField(providerFailures.streamAborts) ?? 0
    }
  };
}

function publicAttempts(value: unknown): Record<string, number> {
  const record = isRecord(value) ? value : {};
  return {
    count: numericField(record.count) ?? 0,
    sum: numericField(record.sum) ?? 0,
    max: numericField(record.max) ?? 0,
    missing: numericField(record.missing) ?? 0,
    average: numericField(record.average) ?? 0
  };
}

function publicNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === "number" && Number.isFinite(count))
      .sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, number>;
}

function numericField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFieldFromRecord(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function publicLeaderboard(
  result: TournamentResult,
  createdAt: string,
  aliases: Map<string, string>,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-leaderboard",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    maxTransitions: result.maxTransitions ?? null,
    modelStats: Object.fromEntries(
      Object.entries(result.modelStats)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicModelStats(stats)])
    ),
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass
  };
}

function publicModelStats(stats: TournamentResult["modelStats"][string]): Record<string, number> {
  return {
    harnessTurns: stats.harnessTurns,
    harnessErrors: stats.harnessErrors,
    nativeSteps: stats.nativeSteps,
    committedSteps: stats.committedSteps,
    rejectedSteps: stats.rejectedSteps,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    latencyMs: stats.latencyMs
  };
}

function publicBenchmarkStatistics(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact>,
  aliases: Map<string, string>,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  const totals = publicStepTotals(result, artifactsByIndex);
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-benchmark-statistics",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    statusCounts: countStatuses(result.episodes),
    nativeSteps: totals.nativeSteps,
    committedSteps: totals.committedSteps,
    rejectedSteps: totals.rejectedSteps,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass,
    modelStats: Object.fromEntries(
      Object.entries(result.modelStats)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicModelStats(stats)])
    )
  };
}

function publicTournamentComparison(
  result: TournamentResult,
  createdAt: string,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-comparison",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount
  };
}

function publicAssignmentExport(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Record<string, unknown> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-roster",
    visibility: "public",
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    episodes: result.episodes.map((episode) => {
      const match = matchesByIndex.get(episode.index);
      return {
        episodeIndex: episode.index,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? match?.harnessStatus ?? null,
        seats: episode.agents.map((agent) => agent.seat).sort((left, right) => left - right),
        nativeSteps: match?.nativeSteps ?? 0,
        committedSteps: match?.committedSteps ?? 0,
        rejectedSteps: match?.rejectedSteps ?? 0,
        matchArtifact: match?.relativePath ?? null,
        matchJsonl: match?.relativeJsonlPath ?? null
      };
    })
  };
}

function publicRegistryExport(createdAt: string, summary: ReturnType<typeof summarizeTournamentMetricPromotions>): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-evaluation-summary",
    visibility: "public",
    createdAt,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass
  };
}

function publicSpecExport(result: TournamentResult, aliases: Map<string, string>): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-spec",
    visibility: "public",
    gamesRequested: result.gamesRequested,
    maxTransitions: result.maxTransitions ?? null,
    modelCount: aliases.size,
    models: [...aliases.values()]
  };
}

function publicManifest(
  result: TournamentResult,
  options: {
    createdAt: string;
    overwrite: boolean;
    publicMatches: PublicTournamentMatchRecord[];
    stepTotals: ReturnType<typeof publicStepTotals>;
    promotionSummary: ReturnType<typeof summarizeTournamentMetricPromotions>;
    integrity: ReturnType<typeof aggregateIntegrityRecords>;
  }
): Record<string, unknown> {
  const statusCounts = countStatuses(result.episodes);
  const integrityErrorCount = options.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament",
    visibility: "public",
    createdAt: options.createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesHarnessCompleted: statusCounts.completed ?? 0,
    gamesHarnessFailed: statusCounts.failed ?? 0,
    maxTransitions: result.maxTransitions ?? null,
    statusCounts,
    nativeSteps: options.stepTotals.nativeSteps,
    committedSteps: options.stepTotals.committedSteps,
    rejectedSteps: options.stepTotals.rejectedSteps,
    metricCount: options.promotionSummary.metricCount,
    scorecardEligibleMetricCount: options.promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: options.promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: options.promotionSummary.scorecardEligibleByClass,
    artifactIntegrityOkCount: options.integrity.filter((record) => record.ok).length,
    artifactIntegrityErrorCount: integrityErrorCount,
    collisionPolicy: options.overwrite ? "overwrite" : "fail-if-exists",
    projection: {
      visibility: "public",
      matchArtifactView: "truth-redacted",
      assignmentTruthRedacted: true,
      publicShareSafe: true,
      schemaVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION
    },
    files: publicFileManifest(options.publicMatches),
    matchCount: options.publicMatches.length,
    matches: options.publicMatches.map((match) => ({
      episodeIndex: match.episodeIndex,
      status: match.status,
      harnessStatus: match.harnessStatus,
      nativeSteps: match.nativeSteps,
      committedSteps: match.committedSteps,
      rejectedSteps: match.rejectedSteps,
      publicMessageCount: match.publicMessageCount,
      playerCount: match.playerCount,
      path: match.relativePath,
      jsonlPath: match.relativeJsonlPath
    }))
  };
}

function publicFileManifest(matches: PublicTournamentMatchRecord[]): Record<string, unknown> {
  return {
    manifest: "manifest.json",
    registry: "registry.json",
    specNormalized: "spec.normalized.json",
    assignment: "assignment.json",
    episodes: "episodes.jsonl",
    trajectory: "trajectory.jsonl",
    metrics: "metrics.jsonl",
    integrity: "integrity.jsonl",
    failures: "failures.jsonl",
    costLatency: "cost_latency.json",
    leaderboard: "leaderboard.json",
    benchmarkStatistics: "benchmark_statistics.json",
    tournamentComparison: "tournament_comparison.json",
    tournamentComparisonMarkdown: "tournament_comparison.md",
    summaryMarkdown: "summary.md",
    episodesCsv: "episodes.csv",
    agentsCsv: "agents.csv",
    metricsCsv: "metrics.csv",
    leaderboardCsv: "leaderboard.csv",
    matches: matches.map((match) => match.relativePath),
    matchesJsonl: matches.map((match) => match.relativeJsonlPath)
  };
}

function publicTrajectoryRecord(match: PublicTournamentMatchRecord): Record<string, unknown> {
  return {
    type: "public_match_summary",
    schemaVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    episodeIndex: match.episodeIndex,
    status: match.status,
    harnessStatus: match.harnessStatus,
    nativeSteps: match.nativeSteps,
    committedSteps: match.committedSteps,
    rejectedSteps: match.rejectedSteps,
    publicMessageCount: match.publicMessageCount,
    playerCount: match.playerCount
  };
}

function publicTournamentSummaryMarkdown(input: {
  createdAt: string;
  result: TournamentResult;
  stepTotals: ReturnType<typeof publicStepTotals>;
  promotionSummary: ReturnType<typeof summarizeTournamentMetricPromotions>;
  integrity: ReturnType<typeof aggregateIntegrityRecords>;
  failures: Array<Record<string, unknown>>;
  publicModelAliases: Map<string, string>;
}): string {
  const integrityErrors = input.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  const modelRows = Object.entries(input.result.modelStats)
    .filter(([model]) => input.publicModelAliases.has(model))
    .map(([model, stats]) => [
      input.publicModelAliases.get(model)!,
      String(stats.harnessTurns),
      String(stats.nativeSteps),
      String(stats.committedSteps),
      String(stats.rejectedSteps)
    ]);
  return [
    "# Public Tournament Summary",
    "",
    "This bundle contains public observations and anonymous aggregate measurements only. It is not replay authority.",
    "",
    "## Run Set",
    "",
    `- Created at: ${input.createdAt}`,
    `- Games requested: ${input.result.gamesRequested}`,
    `- Games completed: ${input.result.gamesCompleted}`,
    `- Games failed: ${input.result.gamesFailed}`,
    `- Native steps: ${input.stepTotals.nativeSteps}`,
    `- Committed steps: ${input.stepTotals.committedSteps}`,
    `- Rejected steps: ${input.stepTotals.rejectedSteps}`,
    `- Integrity errors: ${integrityErrors}`,
    `- Failure summaries: ${input.failures.length}`,
    `- Metric rows: ${input.promotionSummary.metricCount}`,
    "",
    "## Anonymous Model Aggregate",
    "",
    markdownTable(
      ["model", "turns", "native", "committed", "rejected"],
      modelRows
    ),
    "",
    "## Publication Boundary",
    "",
    "Seeds, profile and policy identities, role/team assignments, private channels, action traces, evaluator evidence, and provider request identifiers are intentionally excluded."
  ].join("\n") + "\n";
}

function publicTournamentComparisonMarkdown(comparison: Record<string, unknown>): string {
  return [
    "# Public Tournament Comparison",
    "",
    "This aggregate intentionally excludes per-match provenance and hidden-truth evidence.",
    "",
    `- Games requested: ${numericField(comparison.gamesRequested) ?? 0}`,
    `- Games completed: ${numericField(comparison.gamesCompleted) ?? 0}`,
    `- Games failed: ${numericField(comparison.gamesFailed) ?? 0}`,
    `- Metric rows: ${numericField(comparison.metricCount) ?? 0}`
  ].join("\n") + "\n";
}

const PUBLIC_EPISODE_CSV_HEADERS = [
  "episode_index",
  "status",
  "harness_status",
  "phase",
  "day",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "public_message_count",
  "player_count",
  "metric_count",
  "scorecard_eligible_metric_count",
  "match_artifact",
  "match_jsonl"
];

const PUBLIC_AGENT_CSV_HEADERS = [
  "episode_index",
  "status",
  "harness_status",
  "seat"
];

const PUBLIC_METRIC_CSV_HEADERS = ["promotion_class", "metric_count", "scorecard_eligible_metric_count"];

const PUBLIC_LEADERBOARD_CSV_HEADERS = [
  "model",
  "harness_turns",
  "harness_errors",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms"
];

function publicEpisodeCsvRows(episodes: Array<Record<string, unknown>>): Array<Record<string, CsvCell>> {
  return episodes.map((episode) => ({
    episode_index: numericField(episode.episodeIndex) ?? 0,
    status: stringFieldFromRecord(episode, "status") ?? "unknown",
    harness_status: stringFieldFromRecord(episode, "harnessStatus") ?? "",
    phase: stringFieldFromRecord(episode, "phase") ?? "",
    day: numericField(episode.day) ?? "",
    native_steps: numericField(episode.nativeSteps) ?? 0,
    committed_steps: numericField(episode.committedSteps) ?? 0,
    rejected_steps: numericField(episode.rejectedSteps) ?? 0,
    public_message_count: numericField(episode.publicMessageCount) ?? 0,
    player_count: numericField(episode.playerCount) ?? 0,
    metric_count: numericField(episode.metricCount) ?? 0,
    scorecard_eligible_metric_count: numericField(episode.scorecardEligibleMetricCount) ?? 0,
    match_artifact: stringFieldFromRecord(episode, "matchArtifact") ?? "",
    match_jsonl: stringFieldFromRecord(episode, "matchJsonl") ?? ""
  }));
}

function publicAgentCsvRows(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Array<Record<string, CsvCell>> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return result.episodes.flatMap((episode) => {
    const match = matchesByIndex.get(episode.index);
    return episode.agents.map((agent) => ({
        episode_index: episode.index,
        status: episode.status,
        harness_status: episode.harnessStatus ?? match?.harnessStatus ?? "",
        seat: agent.seat
      }));
  });
}

function publicMetricCsvRows(metrics: Array<Record<string, unknown>>): Array<Record<string, CsvCell>> {
  return metrics.map((metric) => ({
    promotion_class: stringFieldFromRecord(metric, "promotionClass") ?? "unknown",
    metric_count: numericField(metric.metricCount) ?? 0,
    scorecard_eligible_metric_count: numericField(metric.scorecardEligibleMetricCount) ?? 0
  }));
}

function publicLeaderboardCsvRows(leaderboard: Record<string, unknown>): Array<Record<string, CsvCell>> {
  const modelStats = isRecord(leaderboard.modelStats) ? leaderboard.modelStats : {};
  return Object.entries(modelStats)
    .filter(([, stats]) => isRecord(stats))
    .map(([model, stats]) => ({
      model,
      harness_turns: numericField((stats as Record<string, unknown>).harnessTurns) ?? 0,
      harness_errors: numericField((stats as Record<string, unknown>).harnessErrors) ?? 0,
      native_steps: numericField((stats as Record<string, unknown>).nativeSteps) ?? 0,
      committed_steps: numericField((stats as Record<string, unknown>).committedSteps) ?? 0,
      rejected_steps: numericField((stats as Record<string, unknown>).rejectedSteps) ?? 0,
      prompt_tokens: numericField((stats as Record<string, unknown>).promptTokens) ?? 0,
      completion_tokens: numericField((stats as Record<string, unknown>).completionTokens) ?? 0,
      latency_ms: numericField((stats as Record<string, unknown>).latencyMs) ?? 0
    }));
}

function assertPublicPackDoesNotContainKnownSecrets(
  values: unknown[],
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[]
): void {
  const sensitiveValues = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 3) sensitiveValues.add(value);
  };
  add(result.seed);
  add(result.experiment.id);
  for (const episode of result.episodes) {
    add(episode.seed);
    add(episode.runId);
    add(episode.matchId);
  }
  for (const profile of result.profiles) {
    add(profile.id);
    add(profile.model);
    add(profile.policyName);
  }
  for (const artifact of artifactRecords) {
    add(artifact.seed);
    add(artifact.runId);
    add(artifact.matchId);
  }
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const secret of sensitiveValues) {
    if (serialized.includes(secret)) {
      throw new Error("Public tournament artifact projection retained a canonical identity or deterministic seed.");
    }
  }
}

function collectArtifactRecords(result: TournamentResult): TournamentMatchArtifactRecord[] {
  if (result.artifacts?.length) return result.artifacts;
  return result.episodes.flatMap((episode) => {
    if (!episode.artifact) return [];
    return [
      {
        index: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? episode.artifact.runId,
        matchId: episode.matchId ?? episode.artifact.matchId,
        artifact: episode.artifact
      }
    ];
  });
}

function buildManifest(
  result: TournamentResult,
  options: {
    experimentId?: string;
    createdAt: string;
    overwrite: boolean;
    artifactRecords: TournamentMatchArtifactRecord[];
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
    matchArtifactView: "full" | "postgame-redacted" | "truth-redacted";
    assignmentTruthRedacted: boolean;
    visibility: TournamentArtifactVisibility;
  }
): object {
  const statusCounts = countStatuses(result.episodes);
  const forkLineage = collectForkLineage(result, options.artifactRecords);
  const warningSummary = summarizeEvaluationWarnings(
    options.artifactRecords.flatMap((record) => record.artifact.evaluationReport.warnings ?? [])
  );
  const integrityRecords = aggregateIntegrityRecords(result, options.artifactRecords, options.relativeMatchPaths, options.relativeMatchJsonlPaths);
  const integrityErrorCount = integrityRecords.reduce((sum, record) => sum + record.errorCount, 0);
  const stepTotals = result.episodes.reduce(
    (totals, episode) => {
      const artifact = options.artifactRecords.find((record) => record.index === episode.index)?.artifact;
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament",
    experimentId: options.experimentId ?? result.experiment.id,
    createdAt: options.createdAt,
    seed: result.seed,
    seedSchedule: result.episodes.map((episode) => ({ index: episode.index, seed: episode.seed })),
    models: result.models,
    profiles: result.profiles,
    assignment: result.assignment ?? null,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesHarnessCompleted: statusCounts.completed ?? 0,
    gamesTruncated: statusCounts.truncated ?? 0,
    gamesHarnessFailed: statusCounts.failed ?? 0,
    maxTransitions: result.maxTransitions ?? null,
    statusCounts,
    nativeSteps: stepTotals.nativeSteps,
    committedSteps: stepTotals.committedSteps,
    rejectedSteps: stepTotals.rejectedSteps,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationWarningCount: warningSummary.warningCount,
    evaluationWarningSeverityCounts: warningSummary.warningSeverityCounts,
    evaluationWarningCodes: warningSummary.warningCodes.map((warning) => warning.code),
    evaluationWarningSummary: warningSummary,
    evaluationCoverage,
    artifactIntegrityOkCount: integrityRecords.filter((record) => record.ok).length,
    artifactIntegrityErrorCount: integrityErrorCount,
    artifactIntegrityErroredMatchCount: integrityRecords.filter((record) => !record.ok).length,
    forkCount: forkLineage.length,
    forks: forkLineage,
    collisionPolicy: options.overwrite ? "overwrite" : "fail-if-exists",
    projection: {
      matchArtifactView: options.matchArtifactView,
      assignmentTruthRedacted: options.assignmentTruthRedacted,
      visibility: options.visibility,
      publicShareSafe: false
    },
    files: {
      manifest: "manifest.json",
      registry: "registry.json",
      specNormalized: "spec.normalized.json",
      assignment: "assignment.json",
      episodes: "episodes.jsonl",
      trajectory: "trajectory.jsonl",
      metrics: "metrics.jsonl",
      integrity: "integrity.jsonl",
      failures: "failures.jsonl",
      costLatency: "cost_latency.json",
      leaderboard: "leaderboard.json",
      benchmarkStatistics: "benchmark_statistics.json",
      tournamentComparison: "tournament_comparison.json",
      tournamentComparisonMarkdown: "tournament_comparison.md",
      summaryMarkdown: "summary.md",
      episodesCsv: "episodes.csv",
      agentsCsv: "agents.csv",
      metricsCsv: "metrics.csv",
      leaderboardCsv: "leaderboard.csv",
      matches: options.artifactRecords.map((record) => options.relativeMatchPaths.get(record.index)).filter(Boolean),
      matchesJsonl: options.artifactRecords.map((record) => options.relativeMatchJsonlPaths.get(record.index)).filter(Boolean)
    },
    matchCount: options.artifactRecords.length,
    matches: options.artifactRecords.map((record) => {
      const matchWarningSummary = summarizeEvaluationWarnings(record.artifact.evaluationReport.warnings);
      const integrity = integrityRecords.find((item) => item.episodeIndex === record.index);
      const episode = result.episodes.find((item) => item.index === record.index);
      const stepCounts = countSocialStepCommits(episode?.socialEpisode?.steps ?? record.artifact.socialEpisode.steps ?? []);
      return {
        episodeIndex: record.index,
        seed: record.seed,
        runId: record.runId,
        matchId: record.matchId ?? null,
        status: record.artifact.status,
        evaluationStatus: record.artifact.evaluationReport.status ?? "completed",
        evaluatorFailureCount: record.artifact.evaluationReport.failures?.length ?? 0,
        evaluationWarningCount: matchWarningSummary.warningCount,
        evaluationWarningCodes: matchWarningSummary.warningCodes.map((warning) => warning.code),
        integrityOk: integrity?.ok ?? false,
        integrityErrorCount: integrity?.errorCount ?? null,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, record.artifact)),
        path: options.relativeMatchPaths.get(record.index) ?? null,
        jsonlPath: options.relativeMatchJsonlPaths.get(record.index) ?? null
      };
    })
  };
}

function buildNormalizedSpecExport(result: TournamentResult): TournamentNormalizedSpecArtifact {
  return result.experiment;
}

function buildAssignmentExport(
  result: TournamentResult,
  options: {
    createdAt: string;
    artifactsByIndex: Map<number, MatchArtifact>;
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
    redactAssignmentTruth?: boolean;
  }
): TournamentAssignmentArtifact {
  const redactTruth = Boolean(options.redactAssignmentTruth);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-assignment",
    createdAt: options.createdAt,
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    models: result.models,
    profiles: result.profiles,
    assignment: result.assignment ?? null,
    episodes: result.episodes.map((episode) => {
      const artifact = options.artifactsByIndex.get(episode.index);
      const resolvedAssignments = episode.resolvedAssignments.length ? episode.resolvedAssignments : artifact?.resolvedAssignments ?? [];
      const agents = assignmentAgentsForEpisode(episode, resolvedAssignments, redactTruth, artifact);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        matchArtifact: options.relativeMatchPaths.get(episode.index) ?? null,
        matchJsonl: options.relativeMatchJsonlPaths.get(episode.index) ?? null,
        assignment: episode.assignment ?? result.assignment ?? artifact?.assignment ?? null,
        resolvedAssignments: redactTruth
          ? resolvedAssignments.map((assignment) => {
              const { role: _role, team: _team, ...rest } = assignment;
              return rest as typeof assignment;
            })
          : resolvedAssignments,
        agents
      };
    })
  };
}

function assignmentAgentsForEpisode(
  episode: TournamentEpisode,
  resolvedAssignments: MatchArtifact["resolvedAssignments"],
  redactTruth = false,
  artifact?: MatchArtifact
): TournamentAssignmentAgentRecord[] {
  const agentsByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  const densityByActor = countSocialStepCommitsByActor(
    episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
  );
  const densityFor = (playerId: string) =>
    densityByActor.get(playerId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
  if (resolvedAssignments.length) {
    return resolvedAssignments.map((assignment) => {
      const agent = agentsByPlayer.get(assignment.playerId);
      const density = densityFor(assignment.playerId);
      return {
        playerId: assignment.playerId,
        seat: assignment.seat,
        profileId: assignment.profileId ?? agent?.profileId,
        model: assignment.model,
        temperature: assignment.temperature,
        role: redactTruth ? undefined : assignment.role ?? agent?.role,
        team: redactTruth ? undefined : assignment.team ?? agent?.team,
        policyName: assignment.policyName ?? agent?.policyName,
        nativeSteps: density.nativeSteps,
        committedSteps: density.committedSteps,
        rejectedSteps: density.rejectedSteps
      };
    });
  }
  return episode.agents.map((agent) => {
    const density = densityFor(agent.playerId);
    return {
      playerId: agent.playerId,
      seat: agent.seat,
      profileId: agent.profileId,
      model: agent.model,
      temperature: null,
      role: redactTruth ? undefined : agent.role,
      team: redactTruth ? undefined : agent.team,
      policyName: agent.policyName,
      nativeSteps: density.nativeSteps,
      committedSteps: density.committedSteps,
      rejectedSteps: density.rejectedSteps
    };
  });
}

function buildRegistrySnapshot(result: TournamentResult, createdAt: string): object {
  const reports = result.episodes.flatMap((episode) => (episode.evaluationReport ? [{ episode, report: episode.evaluationReport }] : []));
  const registryEntries = [
    benchmarkStatisticsManifestEntry(),
    ...reports.flatMap(({ report }) =>
      report.evaluatorRegistry?.length
        ? report.evaluatorRegistry
        : report.evaluatorIds.map((id) => ({
            id,
            label: id,
            version: "unknown"
          }))
    )
  ];
  const registryById = new Map(registryEntries.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const promotionMetadata = metricPromotionExportMetadata(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "evaluator-registry-snapshot",
    createdAt,
    evaluatorIds: Array.from(new Set(registryEntries.map((entry) => entry.id))),
    evaluators: [...registryById.values()],
    ...promotionMetadata,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationCoverage,
    reports: reports.map(({ episode, report }) => ({
      episodeIndex: episode.index,
      seed: episode.seed,
      matchId: episode.matchId ?? null,
      runId: episode.runId ?? null,
      reportId: report.id,
      createdAt: report.createdAt,
      status: report.status ?? "completed",
      evaluatorFailureCount: report.failures?.length ?? 0,
      evaluatorIds: report.evaluatorIds,
      evaluatorRegistry: report.evaluatorRegistry ?? [],
      metricCount: report.metricCount,
      warnings: report.warnings ?? [],
      warningSummary: summarizeEvaluationWarnings(report.warnings),
      summary: report.summary
    }))
  };
}

function benchmarkStatisticsManifestEntry(): HarnessEvaluatorManifestEntry {
  return {
    id: BENCHMARK_STATISTICS_EVALUATOR_ID,
    label: "Benchmark statistics run-set evaluator",
    version: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
    inputSchema: "harness.tournament-result.v1",
    outputSchema: BENCHMARK_STATISTICS_VERSION,
    mode: "deterministic",
    metricIds: BENCHMARK_STATISTICS_METRIC_IDS,
    rubric:
      "Aggregates run-set denominators, seed ledger, artifact coverage, and descriptive stratification counts. It does not claim model superiority, causal influence, or counterfactual effects.",
    dependencies: {
      artifacts: "TournamentResult episodes, match artifacts, assignment artifact, failure records, metrics records, and normalized experiment spec"
    },
    aggregation: "run_set_denominators_and_strata",
    visibility: "postgame"
  };
}

function episodeRecord(
  episode: TournamentEpisode,
  matchPath?: string,
  matchJsonlPath?: string,
  artifact?: MatchArtifact,
  redactTruth = false
): object {
  const resolvedAssignments = redactTruth
    ? episode.resolvedAssignments.map((assignment) => {
        const { role: _role, team: _team, ...rest } = assignment;
        return rest;
      })
    : episode.resolvedAssignments;
  const densityByActor = countSocialStepCommitsByActor(
    episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
  );
  const profileExecution = profileExecutionRecords(episode, artifact);
  const agents = episode.agents.map((agent) => {
    const density = densityByActor.get(agent.playerId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    const withDensity = {
      ...agent,
      nativeSteps: density.nativeSteps,
      committedSteps: density.committedSteps,
      rejectedSteps: density.rejectedSteps
    };
    if (!redactTruth) return withDensity;
    const { role: _role, team: _team, won: _won, ...rest } = withDensity;
    return rest;
  });
  const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
  const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
    episode.evaluationReport?.metrics ?? [],
    promotionFallbackPolicyForReport(episode.evaluationReport)
  );
  return {
    type: "episode",
    episodeIndex: episode.index,
    tournamentEpisodeIndex: episode.index,
    index: episode.index,
    seed: episode.seed,
    runId: episode.runId ?? null,
    matchId: episode.matchId ?? null,
    status: episode.status,
    harnessStatus: episode.harnessStatus ?? null,
    jointPhaseScheduler: episode.jointPhaseScheduler ?? null,
    winner: redactTruth ? null : episode.winner ?? null,
    phase: episode.phase ?? null,
    day: episode.day ?? null,
    nativeSteps: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    trajectorySteps: episode.trajectory?.length ?? artifact?.trajectory.length ?? 0,
    socialStatus: episode.socialEpisode?.status ?? null,
    messageCount: episode.socialEpisode?.messages.length ?? artifact?.socialEpisode.messages.length ?? 0,
    metricCount: episode.evaluationReport?.metricCount ?? promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    // Evaluation coverage is control-plane metadata, not hidden role truth.
    // Keep it in a truth-redacted research row so the persisted raw inputs can
    // distinguish a missing report from a completed report with zero failures.
    hasEvaluationReport: Boolean(episode.evaluationReport),
    evaluationStatus: episode.evaluationReport ? episode.evaluationReport.status ?? "completed" : null,
    evaluatorFailureCount: episode.evaluationReport?.failures?.length ?? 0,
    evaluationWarningCount: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCount,
    evaluationWarningCodes: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCodes.map((warning) => warning.code),
    warningSummary: summarizeEvaluationWarnings(episode.evaluationReport?.warnings),
    evaluatorIds: episode.evaluationReport?.evaluatorIds ?? [],
    forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
    assignment: episode.assignment ?? null,
    resolvedAssignments,
    agents,
    // This mirrors TournamentResult's historical profile aggregation exactly:
    // native density is attributed by step.profileId (falling back to the
    // actor's assigned profile), while harness turns are only committed
    // compatibility traces. Neither can safely be inferred from actor density.
    profileExecution,
    error: episode.error ?? null,
    matchArtifact: matchPath ?? null,
    matchJsonl: matchJsonlPath ?? null
  };
}

function profileExecutionRecords(
  episode: TournamentEpisode,
  artifact?: MatchArtifact
): Array<{
  profileId: string;
  model: string;
  harnessTurns: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}> {
  const agentByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  const byProfile = new Map<
    string,
    {
      profileId: string;
      model: string;
      harnessTurns: number;
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
    }
  >();
  const ensure = (profileId: string, model: string) => {
    const existing = byProfile.get(profileId);
    if (existing) return existing;
    const created = {
      profileId,
      model,
      harnessTurns: 0,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    byProfile.set(profileId, created);
    return created;
  };
  const steps = episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? [];
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const actor = agentByPlayer.get(step.actorId);
    const profileId = step.profileId || actor?.profileId;
    if (!profileId) continue;
    const density = ensure(profileId, actor?.model ?? "unknown");
    density.nativeSteps += 1;
    if (isSocialStepCommitted(step)) density.committedSteps += 1;
    else density.rejectedSteps += 1;
  }
  for (const trace of episode.evaluation?.trajectory ?? []) {
    if (!trace.profileId) continue;
    ensure(trace.profileId, trace.model).harnessTurns += 1;
  }
  return [...byProfile.values()].sort((left, right) => left.profileId.localeCompare(right.profileId));
}

function aggregateTrajectoryRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  projectMatchArtifact?: (artifact: MatchArtifact) => unknown
): object[] {
  return artifactRecords.flatMap((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    const sourceArtifact = projectMatchArtifact ? projectMatchArtifact(record.artifact) : record.artifact;
    return trajectoryRecordsFromArtifact(sourceArtifact).map((parsed) => {
      return {
        ...parsed,
        episodeIndex: record.index,
        tournamentEpisodeIndex: record.index,
        tournamentSeed: result.seed,
        episodeSeed: episode?.seed ?? record.seed,
        runId: typeof parsed.runId === "string" ? parsed.runId : record.runId,
        matchId: typeof parsed.matchId === "string" ? parsed.matchId : record.matchId ?? null
      };
    });
  });
}

function trajectoryRecordsFromArtifact(artifact: unknown): Record<string, unknown>[] {
  return toTrajectoryJsonl(artifact as TrajectoryJsonlSource)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function aggregateMetricRecords(result: TournamentResult, redactTruth = false): object[] {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => {
      const agents = episode.agents.map((agent) => {
        if (!redactTruth) {
          return {
            playerId: agent.playerId,
            profileId: agent.profileId,
            model: agent.model,
            role: agent.role,
            team: agent.team,
            seat: agent.seat
          };
        }
        return {
          playerId: agent.playerId,
          profileId: agent.profileId,
          model: agent.model,
          seat: agent.seat
        };
      });
      const subject =
        redactTruth && metric.subject && typeof metric.subject === "object"
          ? (() => {
              const { role: _role, team: _team, ...rest } = metric.subject as Record<string, unknown>;
              return rest;
            })()
          : metric.subject;
      const promotion = resolveRecordedMetricPromotion(metric, promotionFallbackPolicyForReport(episode.evaluationReport));
      return {
        type: "metric",
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        tournamentSeed: result.seed,
        episodeSeed: episode.seed,
        runId: episode.runId ?? null,
        matchId: episode.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        agents,
        evaluationReportId: episode.evaluationReport?.id,
        ...metric,
        subject,
        promotionClass: promotion.promotionClass,
        scorecardEligible: promotion.eligibleForScorecard,
        promotionReasons: promotion.reasons,
        promotionDecisionId: promotion.catalogDecisionId ?? null,
        promotionPolicyId: promotion.policyId,
        promotionPolicyVersion: promotion.policyVersion,
        promotionPolicyHash: promotion.policyHash,
        promotionCatalogId: promotion.catalogId,
        promotionCatalogVersion: promotion.catalogVersion,
        promotionCatalogHash: promotion.catalogHash,
        promotionResolution: promotion.resolution
      };
    })
  );
}

function aggregateIntegrityRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>
): Array<{
  type: "artifact_integrity";
  episodeIndex: number;
  tournamentEpisodeIndex: number;
  tournamentSeed: string;
  episodeSeed: string;
  runId: string;
  matchId: string | null;
  status: MatchArtifact["status"];
  ok: boolean;
  errorCount: number;
  errors: string[];
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  matchArtifact: string | null;
  matchJsonl: string | null;
}> {
  return artifactRecords.map((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    const errors = validateMatchArtifactIntegrity(record.artifact);
    const stepCounts = countSocialStepCommits(
      episode?.socialEpisode?.steps ?? record.artifact.socialEpisode.steps ?? []
    );
    return {
      type: "artifact_integrity",
      episodeIndex: record.index,
      tournamentEpisodeIndex: record.index,
      tournamentSeed: result.seed,
      episodeSeed: episode?.seed ?? record.seed,
      runId: record.runId,
      matchId: record.matchId ?? null,
      status: record.artifact.status,
      ok: errors.length === 0,
      errorCount: errors.length,
      errors,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      matchArtifact: relativeMatchPaths.get(record.index) ?? null,
      matchJsonl: relativeMatchJsonlPaths.get(record.index) ?? null
    };
  });
}

function aggregateFailureRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>,
  redactTruth = false
): object[] {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const executionFailures = result.episodes
    .filter((episode) => episode.status === "failed" || episode.harnessStatus === "failed")
    .map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const failureAttributions = failureAttributionsForEpisode(episode, artifact, redactTruth);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        type: "failure",
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        tournamentSeed: result.seed,
        episodeSeed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        failureReason: episode.error ?? artifact?.failureReason ?? null,
        failureStateHash: artifact?.failureStateHash ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        harnessErrorCount: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? null,
        primaryFailure: failureAttributions[0] ?? null,
        failureAttributions,
        agents: (() => {
          const densityByActor = countSocialStepCommitsByActor(
            episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
          );
          return episode.agents.map((agent) => {
            const density = densityByActor.get(agent.playerId) ?? {
              nativeSteps: 0,
              committedSteps: 0,
              rejectedSteps: 0
            };
            const withDensity = {
              ...agent,
              nativeSteps: density.nativeSteps,
              committedSteps: density.committedSteps,
              rejectedSteps: density.rejectedSteps
            };
            if (!redactTruth) return withDensity;
            const { role: _role, team: _team, won: _won, ...rest } = withDensity;
            return rest;
          });
        })(),
        partialArtifact: relativeMatchPaths.get(episode.index) ?? null
      };
    });
  if (redactTruth) return executionFailures;

  const evaluatorFailures = result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const report = episode.evaluationReport ?? artifact?.evaluationReport;
    if (!report?.failures?.length) return [];
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    return report.failures.map((failure) => ({
      type: "evaluation_failure",
      episodeIndex: episode.index,
      tournamentEpisodeIndex: episode.index,
      tournamentSeed: result.seed,
      episodeSeed: episode.seed,
      runId: episode.runId ?? artifact?.runId ?? null,
      matchId: episode.matchId ?? artifact?.matchId ?? null,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
      evaluationStatus: report.status ?? "completed",
      evaluatorFailure: failure,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      partialArtifact: relativeMatchPaths.get(episode.index) ?? null
    }));
  });
  return [...executionFailures, ...evaluatorFailures];
}

function failureAttributionsForEpisode(
  episode: TournamentEpisode,
  artifact?: MatchArtifact,
  redactTruth = false
): TournamentFailureAttribution[] {
  const agentByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  return harnessFailureEvidenceFromEpisode(artifact?.socialEpisode)
    .map((failure) => {
      const payload = failure.payload ?? failurePayload(failure.failure.metadata);
      const actorId = failure.actorId ?? null;
      const agent = actorId ? agentByPlayer.get(actorId) : undefined;
      const providerFailure = payload.providerFailure ?? null;
      return {
        actorId,
        profileId: agent?.profileId ?? null,
        model: agent?.model ?? payload.model ?? null,
        seat: agent?.seat ?? null,
        role: redactTruth ? null : agent?.role ?? null,
        team: redactTruth ? null : agent?.team ?? null,
        policyName: agent?.policyName ?? null,
        actionKind: payload.actionKind ?? null,
        traceId: payload.traceId ?? failure.traceId ?? null,
        eventId: null,
        eventSeq: null,
        failureKind: providerFailure?.failureKind ?? null,
        providerStage: providerFailure?.providerStage ?? null,
        status: providerFailure?.status ?? null,
        timeoutMs: providerFailure?.timeoutMs ?? null,
        aborted: providerFailure?.aborted ?? null,
        retryable: providerFailure?.retryable ?? null,
        attempts: providerFailure?.attempts ?? null,
        maxAttempts: providerFailure?.maxAttempts ?? null,
        providerFailure,
        source: "social_step_failure"
      };
    });
}

function failurePayload(payload: unknown): {
  model?: string;
  actionKind?: string;
  traceId?: string;
  providerFailure?: ProviderFailureSummary;
} {
  if (!isRecord(payload)) return {};
  return {
    model: typeof payload.model === "string" ? payload.model : undefined,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : undefined,
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    providerFailure: providerFailurePayload(payload.providerFailure)
  };
}

function providerFailurePayload(value: unknown): ProviderFailureSummary | undefined {
  if (!isRecord(value)) return undefined;
  const failureKind = typeof value.failureKind === "string" ? value.failureKind : undefined;
  if (!isProviderFailureKind(failureKind)) return undefined;
  const summary: ProviderFailureSummary = { failureKind };
  const providerStage = typeof value.providerStage === "string" ? value.providerStage : undefined;
  if (isProviderFailureStage(providerStage)) summary.providerStage = providerStage;
  copyNumber(value, summary, "status");
  copyNumber(value, summary, "timeoutMs");
  copyBoolean(value, summary, "aborted");
  copyBoolean(value, summary, "retryable");
  copyNumber(value, summary, "attempts");
  copyNumber(value, summary, "maxAttempts");
  return summary;
}

function copyNumber(source: Record<string, unknown>, target: ProviderFailureSummary, key: "status" | "timeoutMs" | "attempts" | "maxAttempts"): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function copyBoolean(source: Record<string, unknown>, target: ProviderFailureSummary, key: "aborted" | "retryable"): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function isProviderFailureStage(value: string | undefined): value is NonNullable<ProviderFailureSummary["providerStage"]> {
  return (
    value === "before_start" ||
    value === "during_request" ||
    value === "during_stream" ||
    value === "during_retry_delay" ||
    value === "http_response" ||
    value === "stream_start" ||
    value === "stream_parse" ||
    value === "stream_finish" ||
    value === "non_stream_parse"
  );
}

function buildTournamentComparisonExport(
  result: TournamentResult,
  options: {
    createdAt: string;
    artifactRecords: TournamentMatchArtifactRecord[];
    matchArtifactView: MatchComparisonView;
    projectMatchArtifact?: (artifact: MatchArtifact) => unknown;
  }
): TournamentComparisonAggregate {
  return buildTournamentComparisonAggregate({
    sources: options.artifactRecords.map((record) => {
      const projected = options.projectMatchArtifact
        ? options.projectMatchArtifact(record.artifact)
        : record.artifact;
      // Projectors may return structural comparison sources (including
      // truth-redacted DTO projections). Comparison is pure projection over
      // those recorded artifacts and does not invent truth.
      const artifact = projected as MatchArtifact;
      return {
        episodeIndex: record.index,
        seed: record.seed,
        runId: record.runId,
        matchId: record.matchId,
        artifact
      };
    }),
    view: options.matchArtifactView,
    tournamentSeed: result.seed,
    gamesRequested: result.gamesRequested,
    experimentId: result.experiment.id,
    createdAt: options.createdAt
  });
}

function buildCostLatencyReport(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  createdAt: string,
  redactTruth = false
): object {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const totals = createEmptyCostLatencyStats();
  const byModel = new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>();
  const episodes = result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const metrics = artifact?.metrics ?? episode.metrics;
    const usage = metrics?.modelUsage ?? {};
    const episodeStats = createEmptyCostLatencyStats();
    const stepCounts = countSocialStepCommits(artifact?.socialEpisode.steps ?? episode.socialEpisode?.steps ?? []);
    episodeStats.harnessTurns = metrics?.harnessTurnCount ?? stepCounts.committedSteps;
    episodeStats.harnessErrors = metrics?.harnessErrorCount ?? 0;
    episodeStats.nativeSteps = stepCounts.nativeSteps;
    episodeStats.committedSteps = stepCounts.committedSteps;
    episodeStats.rejectedSteps = stepCounts.rejectedSteps;

    const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
    const densityByActor = countSocialStepCommitsByActor(
      artifact?.socialEpisode.steps ?? episode.socialEpisode?.steps ?? []
    );
    for (const [actorId, density] of densityByActor) {
      const modelName = modelByPlayer.get(actorId);
      if (!modelName) continue;
      const modelStats = byModel.get(modelName) ?? createEmptyCostLatencyStats();
      modelStats.nativeSteps += density.nativeSteps;
      modelStats.committedSteps += density.committedSteps;
      modelStats.rejectedSteps += density.rejectedSteps;
      byModel.set(modelName, modelStats);
    }

    for (const [model, modelUsage] of Object.entries(usage)) {
      addModelUsage(episodeStats, modelUsage);
      addModelUsage(totals, modelUsage);
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      addModelUsage(modelStats, modelUsage);
      modelStats.harnessTurns += modelUsage.calls;
      byModel.set(model, modelStats);
    }
    totals.harnessTurns += episodeStats.harnessTurns;
    totals.harnessErrors += episodeStats.harnessErrors;
    totals.nativeSteps += episodeStats.nativeSteps;
    totals.committedSteps += episodeStats.committedSteps;
    totals.rejectedSteps += episodeStats.rejectedSteps;

    const traceStats = traceCostLatencyStats(artifact);
    mergeTraceStats(episodeStats, traceStats);
    mergeTraceStats(totals, traceStats);
    for (const [model, stats] of traceStats.byModel.entries()) {
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      mergeTraceStats(modelStats, stats);
      byModel.set(model, modelStats);
    }

    for (const attribution of failureAttributionsForEpisode(episode, artifact, redactTruth)) {
      if (!attribution.providerFailure) continue;
      recordProviderFailure(episodeStats.providerFailures, attribution.providerFailure);
      recordProviderFailure(totals.providerFailures, attribution.providerFailure);
      const model = attribution.model ?? "unknown";
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      recordProviderFailure(modelStats.providerFailures, attribution.providerFailure);
      byModel.set(model, modelStats);
    }

    return {
      episodeIndex: episode.index,
      tournamentEpisodeIndex: episode.index,
      tournamentSeed: result.seed,
      episodeSeed: episode.seed,
      runId: episode.runId ?? artifact?.runId ?? null,
      matchId: episode.matchId ?? artifact?.matchId ?? null,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
      attempts: traceStats.attempts,
      ...finalizeCostLatencyStats(episodeStats),
      modelUsage: Object.fromEntries(
        Object.entries(usage).map(([model, modelUsage]) => [
          model,
          {
            ...modelUsage,
            averageLatencyMs: modelUsage.calls ? Math.round(modelUsage.latencyMs / modelUsage.calls) : 0
          }
        ])
      )
    };
  });

  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-cost-latency",
    createdAt,
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    pricing: {
      costEstimate: null,
      currency: null,
      note: "Token and latency totals are recorded, but no provider pricing table is configured in this harness."
    },
    totals: finalizeCostLatencyStats(totals),
    byModel: Object.fromEntries([...byModel.entries()].map(([model, stats]) => [model, finalizeCostLatencyStats(stats)])),
    episodes
  };
}

function buildLeaderboard(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact> = new Map(),
  benchmarkStatistics: object = buildBenchmarkStatistics(result, createdAt, artifactsByIndex),
  rebuilt: RebuiltTournamentLeaderboard,
  redactTruth = false
): object {
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-leaderboard",
    createdAt,
    seed: result.seed,
    models: result.models,
    profiles: result.profiles,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    maxTransitions: result.maxTransitions ?? null,
    assignment: result.assignment ?? null,
    // `modelStats`/`profileStats` and metric coverage are reconstructed from
    // the same persisted raw rows written beside this file.  They deliberately
    // do not trust TournamentResult's in-memory aggregate cache.
    aggregation: {
      source: ["spec.normalized.json", "episodes.jsonl", "metrics.jsonl", "cost_latency.json"],
      completedOnly: true,
      promotionResolution: "recorded_raw_metric_fields"
    },
    modelStats: rebuilt.modelStats,
    profileStats: rebuilt.profileStats,
    metricCount: rebuilt.metricPromotion.metricCount,
    scorecardEligibleMetricCount: rebuilt.metricPromotion.scorecardEligibleCount,
    metricPromotionClassCounts: rebuilt.metricPromotion.byClass,
    scorecardEligibleMetricClassCounts: rebuilt.metricPromotion.scorecardEligibleByClass,
    evaluationCoverage: rebuilt.evaluationCoverage,
    benchmarkStatistics,
    episodes: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        index: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        winner: redactTruth ? null : episode.winner ?? null,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        error: episode.error ?? null
      };
    })
  };
}

function buildBenchmarkStatistics(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact>,
  redactTruth = false
): object {
  const harnessStatusCounts = countStatuses(result.episodes);
  const scheduledEpisodes = result.episodes.length;
  const artifactCount = artifactsByIndex.size;
  const agentStrata = {
    byModel: new Map<string, BenchmarkAgentSeatStratum>(),
    byProfile: new Map<string, BenchmarkAgentSeatStratum>(),
    byRole: new Map<string, BenchmarkAgentSeatStratum>(),
    byTeam: new Map<string, BenchmarkAgentSeatStratum>(),
    bySeat: new Map<string, BenchmarkAgentSeatStratum>()
  };
  const episodeStrata = {
    byEpisodeStatus: new Map<string, BenchmarkEpisodeStratum>(),
    byHarnessStatus: new Map<string, BenchmarkEpisodeStratum>()
  };
  let nativeSteps = 0;
  let committedSteps = 0;
  let rejectedSteps = 0;
  for (const episode of result.episodes) {
    const artifact = artifactsByIndex.get(episode.index);
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    nativeSteps += stepCounts.nativeSteps;
    committedSteps += stepCounts.committedSteps;
    rejectedSteps += stepCounts.rejectedSteps;
    recordEpisodeStratum(episodeStrata.byEpisodeStatus, "episodeStatus", episode.status, episode, artifact, stepCounts);
    recordEpisodeStratum(episodeStrata.byHarnessStatus, "harnessStatus", episode.harnessStatus ?? "tournamentFailed", episode, artifact, stepCounts);
    const densityByActor = countSocialStepCommitsByActor(
      episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
    );
    for (const agent of episode.agents) {
      const density = densityByActor.get(agent.playerId) ?? {
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      recordAgentSeatStratum(agentStrata.byModel, "model", agent.model, episode, agent, density);
      if (agent.profileId) {
        recordAgentSeatStratum(agentStrata.byProfile, "profile", agent.profileId, episode, agent, density);
      }
      if (!redactTruth) {
        if (agent.role) recordAgentSeatStratum(agentStrata.byRole, "role", agent.role, episode, agent, density);
        if (agent.team) recordAgentSeatStratum(agentStrata.byTeam, "team", agent.team, episode, agent, density);
      }
      recordAgentSeatStratum(agentStrata.bySeat, "seat", String(agent.seat), episode, agent, density);
    }
  }
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const promotionMetadata = metricPromotionExportMetadata(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);

  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-benchmark-statistics",
    schemaVersion: BENCHMARK_STATISTICS_VERSION,
    evaluatorId: BENCHMARK_STATISTICS_EVALUATOR_ID,
    evaluatorVersion: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
    metricIds: BENCHMARK_STATISTICS_METRIC_IDS,
    createdAt,
    benchmarkId: result.experiment.id,
    runSetId: `${result.seed}:requested=${result.gamesRequested}:scheduled=${scheduledEpisodes}`,
    experimentSpecVersion: result.experiment.version,
    experimentSpecHash: hashStableState(result.experiment),
    visibility: "postgame",
    inputArtifacts: ["spec.normalized.json", "assignment.json", "episodes.jsonl", "integrity.jsonl", "matches/*.json"],
    denominatorPolicy: {
      requestedEpisodes: "All requested tournament episodes, including unscheduled episodes after an early stop.",
      scheduledEpisodes: "Episodes present in TournamentResult.episodes.",
      completedOnlyAggregates: "Existing modelStats and profileStats aggregate only episodes with episode.status === completed.",
      failedEpisodes: "Harness and pre-harness failures remain in status denominators and failure artifacts, not in completed-only reward averages.",
      superiorityClaims: false
    },
    comparisonPolicy: {
      pairedSeedDeltas: "not_available_without_paired_design_contract",
      headToHeadMatrix: "not_available_without_paired_design_contract",
      confidenceIntervals: "not_available_without_metric_specific_interval_contract",
      effectSizes: "not_available_without_metric_specific_effect_size_contract"
    },
    ...promotionMetadata,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationCoverage,
    statusDenominators: {
      gamesRequested: result.gamesRequested,
      episodesScheduled: scheduledEpisodes,
      episodesUnscheduled: Math.max(0, result.gamesRequested - scheduledEpisodes),
      gamesCompleted: result.gamesCompleted,
      gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
      gamesFailed: result.gamesFailed,
      artifactCount,
      matchArtifactCount: artifactCount,
      completedWithEvaluation: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluation)).length,
      completedWithEvaluationReport: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluationReport)).length,
      evaluationCompletedEpisodes: evaluationCoverage.evaluationCompletedEpisodes,
      evaluationIncompleteEpisodes: evaluationCoverage.evaluationIncompleteEpisodes,
      evaluatorFailureCount: evaluationCoverage.evaluatorFailureCount,
      truncatedWithArtifact: result.episodes.filter((episode) => episode.status === "truncated" && artifactsByIndex.has(episode.index)).length,
      truncatedWithEvaluation: result.episodes.filter((episode) => episode.status === "truncated" && Boolean(episode.evaluation)).length,
      truncatedWithEvaluationReport: result.episodes.filter((episode) => episode.status === "truncated" && Boolean(episode.evaluationReport)).length,
      failedWithArtifact: result.episodes.filter((episode) => episode.status === "failed" && artifactsByIndex.has(episode.index)).length,
      preHarnessFailures: result.episodes.filter((episode) => episode.status === "failed" && !episode.harnessStatus).length,
      harnessStatusCounts,
      nativeSteps,
      committedSteps,
      rejectedSteps
    },
    stratificationDimensions: redactTruth
      ? ["model", "profile", "seat", "episodeStatus", "harnessStatus"]
      : ["model", "profile", "role", "team", "seat", "episodeStatus", "harnessStatus"],
    seedLedger: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        hasArtifact: Boolean(artifact),
        hasEvaluation: Boolean(episode.evaluation),
        hasEvaluationReport: Boolean(episode.evaluationReport),
        evaluationStatus: episode.evaluationReport ? episode.evaluationReport.status ?? "completed" : null,
        evaluatorFailureCount: episode.evaluationReport?.failures?.length ?? 0,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps
      };
    }),
    strata: {
      byModel: mapToSortedRecord(agentStrata.byModel, finalizeAgentSeatStratum),
      byProfile: mapToSortedRecord(agentStrata.byProfile, finalizeAgentSeatStratum),
      ...(redactTruth
        ? {}
        : {
            byRole: mapToSortedRecord(agentStrata.byRole, finalizeAgentSeatStratum),
            byTeam: mapToSortedRecord(agentStrata.byTeam, finalizeAgentSeatStratum)
          }),
      bySeat: mapToSortedRecord(agentStrata.bySeat, finalizeAgentSeatStratum),
      byEpisodeStatus: mapToSortedRecord(episodeStrata.byEpisodeStatus, finalizeEpisodeStratum),
      byHarnessStatus: mapToSortedRecord(episodeStrata.byHarnessStatus, finalizeEpisodeStratum)
    }
  };
}

function recordAgentSeatStratum(
  strata: Map<string, BenchmarkAgentSeatStratum>,
  dimension: BenchmarkAgentSeatStratum["dimension"],
  key: string,
  episode: TournamentEpisode,
  agent: TournamentEpisode["agents"][number],
  density: { nativeSteps: number; committedSteps: number; rejectedSteps: number } = {
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0
  }
): void {
  const stats = strata.get(key) ?? createAgentSeatStratum(dimension, key);
  stats.scheduledSeatCount += 1;
  if (episode.status === "completed") {
    stats.completedSeatCount += 1;
  } else if (episode.status === "truncated") {
    stats.truncatedSeatCount += 1;
  } else {
    stats.failedSeatCount += 1;
  }
  if (agent.won !== undefined) {
    stats.completedWithOutcomeCount += 1;
    if (agent.won) stats.winCount += 1;
  }
  if (typeof agent.reward === "number" && Number.isFinite(agent.reward)) {
    stats.rewardCount += 1;
    stats.rewardTotal += agent.reward;
  }
  stats.nativeSteps += density.nativeSteps;
  stats.committedSteps += density.committedSteps;
  stats.rejectedSteps += density.rejectedSteps;
  addUniqueNumber(stats.episodeIndexes, episode.index);
  addUnique(stats.seeds, episode.seed);
  strata.set(key, stats);
}

function createAgentSeatStratum(dimension: BenchmarkAgentSeatStratum["dimension"], key: string): BenchmarkAgentSeatStratum {
  return {
    dimension,
    key,
    scheduledSeatCount: 0,
    completedSeatCount: 0,
    truncatedSeatCount: 0,
    failedSeatCount: 0,
    completedWithOutcomeCount: 0,
    winCount: 0,
    rewardCount: 0,
    rewardTotal: 0,
    averageReward: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    episodeIndexes: [],
    seeds: []
  };
}

function finalizeAgentSeatStratum(stats: BenchmarkAgentSeatStratum): BenchmarkAgentSeatStratum {
  return {
    ...stats,
    rewardTotal: round3(stats.rewardTotal),
    averageReward: stats.rewardCount ? round3(stats.rewardTotal / stats.rewardCount) : 0
  };
}

function recordEpisodeStratum(
  strata: Map<string, BenchmarkEpisodeStratum>,
  dimension: BenchmarkEpisodeStratum["dimension"],
  key: string,
  episode: TournamentEpisode,
  artifact: MatchArtifact | undefined,
  density: { nativeSteps: number; committedSteps: number; rejectedSteps: number } = {
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0
  }
): void {
  const stats = strata.get(key) ?? createEpisodeStratum(dimension, key);
  stats.episodeCount += 1;
  if (episode.status === "completed") {
    stats.completedCount += 1;
  } else if (episode.status === "truncated") {
    stats.truncatedCount += 1;
  } else {
    stats.failedCount += 1;
  }
  if (artifact) stats.artifactCount += 1;
  if (episode.evaluation) stats.evaluationCount += 1;
  if (episode.evaluationReport) stats.evaluationReportCount += 1;
  stats.harnessErrorCount += episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0;
  stats.nativeSteps += density.nativeSteps;
  stats.committedSteps += density.committedSteps;
  stats.rejectedSteps += density.rejectedSteps;
  addUniqueNumber(stats.episodeIndexes, episode.index);
  addUnique(stats.seeds, episode.seed);
  strata.set(key, stats);
}

function createEpisodeStratum(dimension: BenchmarkEpisodeStratum["dimension"], key: string): BenchmarkEpisodeStratum {
  return {
    dimension,
    key,
    episodeCount: 0,
    completedCount: 0,
    truncatedCount: 0,
    failedCount: 0,
    artifactCount: 0,
    evaluationCount: 0,
    evaluationReportCount: 0,
    harnessErrorCount: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    episodeIndexes: [],
    seeds: []
  };
}

function finalizeEpisodeStratum(stats: BenchmarkEpisodeStratum): BenchmarkEpisodeStratum {
  return { ...stats };
}

function mapToSortedRecord<T>(map: Map<string, T>, finalize: (value: T) => T): Record<string, T> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, finalize(value)]));
}

function createEmptyCostLatencyStats(): {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  harnessTurns: number;
  harnessErrors: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  attempts: {
    count: number;
    sum: number;
    max: number;
    missing: number;
  };
  providerFailures: ReturnType<typeof createEmptyProviderFailureStats>;
} {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    harnessTurns: 0,
    harnessErrors: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    attempts: {
      count: 0,
      sum: 0,
      max: 0,
      missing: 0
    },
    providerFailures: createEmptyProviderFailureStats()
  };
}

function createEmptyProviderFailureStats(): {
  count: number;
  byKind: Record<string, number>;
  byStage: Record<string, number>;
  byStatus: Record<string, number>;
  retryable: number;
  aborted: number;
  timeouts: number;
  streamAborts: number;
  attempts: {
    count: number;
    sum: number;
    max: number;
    missing: number;
  };
} {
  return {
    count: 0,
    byKind: {},
    byStage: {},
    byStatus: {},
    retryable: 0,
    aborted: 0,
    timeouts: 0,
    streamAborts: 0,
    attempts: {
      count: 0,
      sum: 0,
      max: 0,
      missing: 0
    }
  };
}

function addModelUsage(stats: ReturnType<typeof createEmptyCostLatencyStats>, usage: { calls: number; promptTokens: number; completionTokens: number; latencyMs: number }): void {
  stats.calls += usage.calls;
  stats.promptTokens += usage.promptTokens;
  stats.completionTokens += usage.completionTokens;
  stats.totalTokens += usage.promptTokens + usage.completionTokens;
  stats.latencyMs += usage.latencyMs;
}

function traceCostLatencyStats(artifact: MatchArtifact | undefined): ReturnType<typeof createEmptyCostLatencyStats> & {
  byModel: Map<string, ReturnType<typeof createEmptyCostLatencyStats>>;
} {
  const stats = Object.assign(createEmptyCostLatencyStats(), {
    byModel: new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>()
  });
  const nativeTraces = werewolfHarnessTurnEvidenceFromEpisode(artifact?.socialEpisode).map(({ trace }) => ({
    model: trace.model,
    attempts: trace.attempts
  }));
  const traces = nativeTraces.length
    ? nativeTraces
    : (artifact?.trajectory ?? []).map((step) => ({
        model: step.model,
        attempts: step.reasonerOutput.attempts
      }));
  for (const trace of traces) {
    const attempts = trace.attempts;
    recordAttempts(stats, attempts);
    const modelStats = stats.byModel.get(trace.model) ?? createEmptyCostLatencyStats();
    recordAttempts(modelStats, attempts);
    stats.byModel.set(trace.model, modelStats);
  }
  return stats;
}

function mergeTraceStats(target: ReturnType<typeof createEmptyCostLatencyStats>, traceStats: ReturnType<typeof createEmptyCostLatencyStats>): void {
  target.attempts.count += traceStats.attempts.count;
  target.attempts.sum += traceStats.attempts.sum;
  target.attempts.max = Math.max(target.attempts.max, traceStats.attempts.max);
  target.attempts.missing += traceStats.attempts.missing;
  mergeProviderFailureStats(target.providerFailures, traceStats.providerFailures);
}

function recordAttempts(
  stats: {
    attempts: {
      count: number;
      sum: number;
      max: number;
      missing: number;
    };
  },
  attempts: number | undefined
): void {
  if (attempts === undefined) {
    stats.attempts.missing += 1;
    return;
  }
  stats.attempts.count += 1;
  stats.attempts.sum += attempts;
  stats.attempts.max = Math.max(stats.attempts.max, attempts);
}

function finalizeCostLatencyStats(stats: ReturnType<typeof createEmptyCostLatencyStats>): object {
  return {
    calls: stats.calls,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    totalTokens: stats.totalTokens,
    latencyMs: stats.latencyMs,
    averageLatencyMs: stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0,
    harnessTurns: stats.harnessTurns,
    harnessErrors: stats.harnessErrors,
    nativeSteps: stats.nativeSteps,
    committedSteps: stats.committedSteps,
    rejectedSteps: stats.rejectedSteps,
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    },
    providerFailures: finalizeProviderFailureStats(stats.providerFailures)
  };
}

function recordProviderFailure(stats: ReturnType<typeof createEmptyProviderFailureStats>, failure: ProviderFailureSummary): void {
  stats.count += 1;
  increment(stats.byKind, failure.failureKind);
  if (failure.providerStage) increment(stats.byStage, failure.providerStage);
  if (failure.status !== undefined) increment(stats.byStatus, String(failure.status));
  if (failure.retryable) stats.retryable += 1;
  if (failure.aborted) stats.aborted += 1;
  if (failure.failureKind === "timeout") stats.timeouts += 1;
  if (failure.aborted && failure.providerStage === "during_stream") stats.streamAborts += 1;
  recordAttempts(stats, failure.attempts);
}

function mergeProviderFailureStats(target: ReturnType<typeof createEmptyProviderFailureStats>, source: ReturnType<typeof createEmptyProviderFailureStats>): void {
  target.count += source.count;
  mergeCounts(target.byKind, source.byKind);
  mergeCounts(target.byStage, source.byStage);
  mergeCounts(target.byStatus, source.byStatus);
  target.retryable += source.retryable;
  target.aborted += source.aborted;
  target.timeouts += source.timeouts;
  target.streamAborts += source.streamAborts;
  target.attempts.count += source.attempts.count;
  target.attempts.sum += source.attempts.sum;
  target.attempts.max = Math.max(target.attempts.max, source.attempts.max);
  target.attempts.missing += source.attempts.missing;
}

function finalizeProviderFailureStats(stats: ReturnType<typeof createEmptyProviderFailureStats>): object {
  return {
    count: stats.count,
    byKind: stats.byKind,
    byStage: stats.byStage,
    byStatus: stats.byStatus,
    retryable: stats.retryable,
    aborted: stats.aborted,
    timeouts: stats.timeouts,
    streamAborts: stats.streamAborts,
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    }
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function addUniqueNumber(values: number[], value: number): void {
  if (!values.includes(value)) values.push(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function collectForkLineage(result: TournamentResult, artifactRecords: TournamentMatchArtifactRecord[]): object[] {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  return result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const forkOf = forkOfForEpisode(episode, artifact);
    if (!forkOf) return [];
    return [
      {
        episodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        forkOf: summarizeForkOf(forkOf)
      }
    ];
  });
}

function forkOfForEpisode(episode?: TournamentEpisode, artifact?: MatchArtifact): HarnessForkProvenance | undefined {
  return episode?.forkOf ?? artifact?.forkOf;
}

function summarizeForkOf(forkOf?: HarnessForkProvenance): TournamentForkSummary | null {
  if (!forkOf) return null;
  return {
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId ?? null,
    parentMatchId: forkOf.parentMatchId ?? null,
    parentBoundaryTraceId: forkOf.parentBoundaryTraceId ?? null,
    parentBoundaryTurnIndex: forkOf.parentBoundaryTurnIndex ?? null,
    parentStateHash: forkOf.parentStateHash,
    parentExecutionPrefixHash: forkOf.parentExecutionPrefixHash,
    parentAgentsHash: forkOf.parentAgentsHash,
    parentChannelsHash: forkOf.parentChannelsHash,
    parentMessagesHash: forkOf.parentMessagesHash,
    parentNativeStepCount: forkOf.parentNativeStepCount,
    parentMessageCount: forkOf.parentMessageCount,
    createdAt: forkOf.createdAt,
    reason: forkOf.reason ?? null
  };
}

function countStatuses(episodes: TournamentEpisode[]): Record<string, number> {
  const counts: Record<string, number> = {
    completed: 0,
    truncated: 0,
    failed: 0,
    tournamentFailed: 0
  };
  for (const episode of episodes) {
    if (episode.harnessStatus) counts[episode.harnessStatus] = (counts[episode.harnessStatus] ?? 0) + 1;
    if (!episode.harnessStatus && episode.status === "failed") counts.tournamentFailed += 1;
  }
  return counts;
}

export function summarizeTournamentMetricPromotionsFromMetrics(
  metrics: HarnessMetricRecord[],
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  const byClass = {
    scorecard: 0,
    diagnostic: 0,
    benchmark_only: 0
  };
  const scorecardEligibleByClass = {
    scorecard: 0,
    diagnostic: 0,
    benchmark_only: 0
  };
  let metricCount = 0;
  let scorecardEligibleCount = 0;
  for (const metric of metrics) {
    const promotion = resolveRecordedMetricPromotion(metric, fallbackPolicy);
    metricCount += 1;
    byClass[promotion.promotionClass] += 1;
    if (promotion.eligibleForScorecard) {
      scorecardEligibleCount += 1;
      scorecardEligibleByClass[promotion.promotionClass] += 1;
    }
  }
  return {
    metricCount,
    scorecardEligibleCount,
    byClass,
    scorecardEligibleByClass
  };
}

export function summarizeTournamentMetricPromotions(result: TournamentResult): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  return summarizeTournamentMetricPromotionsFromReports(
    result.episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []))
  );
}

export function summarizeTournamentMetricPromotionsFromReports(reports: readonly HarnessEvaluationReport[]): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  const aggregate = {
    metricCount: 0,
    scorecardEligibleCount: 0,
    byClass: {
      scorecard: 0,
      diagnostic: 0,
      benchmark_only: 0
    },
    scorecardEligibleByClass: {
      scorecard: 0,
      diagnostic: 0,
      benchmark_only: 0
    }
  };
  for (const report of reports) {
    const summary = summarizeTournamentMetricPromotionsFromMetrics(
      report.metrics ?? [],
      promotionFallbackPolicyForReport(report)
    );
    aggregate.metricCount += summary.metricCount;
    aggregate.scorecardEligibleCount += summary.scorecardEligibleCount;
    for (const promotionClass of ["scorecard", "diagnostic", "benchmark_only"] as const) {
      aggregate.byClass[promotionClass] += summary.byClass[promotionClass];
      aggregate.scorecardEligibleByClass[promotionClass] += summary.scorecardEligibleByClass[promotionClass];
    }
  }
  return aggregate;
}

function buildTournamentSummaryMarkdown(
  result: TournamentResult,
  options: {
    createdAt: string;
    experimentId: string;
    artifactRecords: TournamentMatchArtifactRecord[];
    integrity: ReturnType<typeof aggregateIntegrityRecords>;
    failures: ReturnType<typeof aggregateFailureRecords>;
    rebuiltLeaderboard: RebuiltTournamentLeaderboard;
  }
): string {
  const warningSummary = summarizeEvaluationWarnings(
    result.episodes.flatMap((episode) => episode.evaluationReport?.warnings ?? [])
  );
  const statusCounts = countStatuses(result.episodes);
  const integrityErrorCount = options.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  const stepTotals = result.episodes.reduce(
    (totals, episode) => {
      const artifact = options.artifactRecords.find((record) => record.index === episode.index)?.artifact;
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const promotionSummary = options.rebuiltLeaderboard.metricPromotion;
  const lines = [
    `# Tournament Summary: ${markdownText(options.experimentId)}`,
    "",
    "## Run Set",
    "",
    `- Created at: ${markdownText(options.createdAt)}`,
    `- Experiment id: ${markdownText(options.experimentId)}`,
    `- Seed: ${markdownText(result.seed)}`,
    `- Models: ${result.models.map(markdownText).join(", ") || "none"}`,
    `- Profiles: ${result.profiles.length}`,
    `- Games requested: ${result.gamesRequested}`,
    `- Episodes scheduled: ${result.episodes.length}`,
    `- Games completed: ${result.gamesCompleted}`,
    `- Games truncated: ${result.gamesTruncated ?? statusCounts.truncated ?? 0}`,
    `- Games failed: ${result.gamesFailed}`,
    `- Match artifacts: ${options.artifactRecords.length}`,
    `- Native steps: ${stepTotals.nativeSteps}`,
    `- Committed steps: ${stepTotals.committedSteps}`,
    `- Rejected steps: ${stepTotals.rejectedSteps}`,
    `- Evaluation warnings: ${warningSummary.warningCount}`,
    `- Integrity errors: ${integrityErrorCount}`,
    `- Failure records: ${options.failures.length}`,
    `- Metric rows: ${promotionSummary.metricCount}`,
    `- Scorecard-eligible metric rows: ${promotionSummary.scorecardEligibleCount}`,
    `- Diagnostic metric rows: ${promotionSummary.byClass.diagnostic}`,
    `- Benchmark-only metric rows: ${promotionSummary.byClass.benchmark_only}`,
    `- Scorecard-class metric rows: ${promotionSummary.byClass.scorecard}`,
    "",
    "## Harness Status",
    "",
    markdownTable(
      ["status", "count"],
      Object.entries(statusCounts).map(([status, count]) => [status, String(count)])
    ),
    "",
    "## Metric Promotion",
    "",
    markdownTable(
      ["promotion_class", "rows", "scorecard_eligible_rows"],
      [
        ["scorecard", String(promotionSummary.byClass.scorecard), String(promotionSummary.scorecardEligibleByClass.scorecard)],
        ["diagnostic", String(promotionSummary.byClass.diagnostic), String(promotionSummary.scorecardEligibleByClass.diagnostic)],
        ["benchmark_only", String(promotionSummary.byClass.benchmark_only), String(promotionSummary.scorecardEligibleByClass.benchmark_only)]
      ]
    ),
    "",
    "Promotion classes are read from each metric's recorded evaluation decision. Older rows without that decision are explicitly marked as `legacy_recomputed` and use only their report-derived fallback policy; a later catalog change does not rewrite recorded rows.",
    "",
    "## Model Leaderboard",
    "",
    markdownTable(
      ["model", "seat_games", "seat_wins", "win_rate", "avg_reward", "turns", "errors", "native", "committed", "rejected"],
      Object.values(options.rebuiltLeaderboard.modelStats).map((stats) => [
        stats.model,
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward),
        String(stats.harnessTurns),
        String(stats.harnessErrors),
        String(stats.nativeSteps),
        String(stats.committedSteps),
        String(stats.rejectedSteps)
      ])
    ),
    "",
    "## Profile Leaderboard",
    "",
    markdownTable(
      ["profile", "model", "policy", "seat_games", "seat_wins", "win_rate", "avg_reward", "native", "committed", "rejected"],
      Object.values(options.rebuiltLeaderboard.profileStats).map((stats) => [
        stats.profileId,
        stats.model,
        stats.policyName ?? "",
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward),
        String(stats.nativeSteps),
        String(stats.committedSteps),
        String(stats.rejectedSteps)
      ])
    ),
    "",
    "## Files",
    "",
    "- `manifest.json`: run-set manifest and artifact file registry",
    "- `spec.normalized.json`: normalized reproducible experiment spec",
    "- `assignment.json`: per-episode profile/model/role/seat assignment ledger",
    "- `episodes.jsonl`, `trajectory.jsonl`, `metrics.jsonl`: machine-readable analysis streams",
    "- `episodes.csv`, `agents.csv`, `metrics.csv`, `leaderboard.csv`: tabular analysis exports",
    "- `integrity.jsonl`, `failures.jsonl`, `cost_latency.json`: audit, failure, and provider telemetry",
    "- `leaderboard.json`, `benchmark_statistics.json`, `tournament_comparison.json`, `tournament_comparison.md`: aggregate deterministic summaries",
    "- `matches/*.json`, `matches/*.jsonl`: per-match artifacts and replay streams",
    "",
    "## Interpretation Policy",
    "",
    "This summary is derived from recorded harness artifacts. It is suitable for run-set inspection and paper experiment bookkeeping. It does not make model superiority, causality, persuasion-success, or counterfactual claims without an explicit paired design and statistical contract."
  ];
  return `${lines.join("\n")}\n`;
}

function episodeCsvRows(
  result: TournamentResult,
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>,
  artifactsByIndex: Map<number, MatchArtifact>,
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const warningSummary = summarizeEvaluationWarnings(episode.evaluationReport?.warnings);
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
      episode.evaluationReport?.metrics ?? [],
      promotionFallbackPolicyForReport(episode.evaluationReport)
    );
    return {
      tournament_seed: result.seed,
      episode_index: episode.index,
      episode_seed: episode.seed,
      run_id: episode.runId ?? artifact?.runId ?? "",
      match_id: episode.matchId ?? artifact?.matchId ?? "",
      status: episode.status,
      harness_status: episode.harnessStatus ?? artifact?.status ?? "",
      winner: redactTruth ? "" : episode.winner ?? artifact?.finalState.winner ?? "",
      phase: episode.phase ?? artifact?.finalState.phase ?? "",
      day: episode.day ?? artifact?.finalState.day ?? "",
      native_steps: stepCounts.nativeSteps,
      committed_steps: stepCounts.committedSteps,
      rejected_steps: stepCounts.rejectedSteps,
      trajectory_steps: episode.trajectory?.length ?? artifact?.trajectory.length ?? 0,
      message_count: episode.socialEpisode?.messages.length ?? artifact?.socialEpisode.messages.length ?? 0,
      metric_count: episode.evaluationReport?.metricCount ?? artifact?.evaluationReport.metricCount ?? promotionSummary.metricCount,
      scorecard_eligible_metric_count: promotionSummary.scorecardEligibleCount,
      scorecard_metric_count: promotionSummary.byClass.scorecard,
      diagnostic_metric_count: promotionSummary.byClass.diagnostic,
      benchmark_only_metric_count: promotionSummary.byClass.benchmark_only,
      warning_count: warningSummary.warningCount,
      warning_codes: warningSummary.warningCodes.map((warning) => warning.code).join("|"),
      harness_error_count: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0,
      agent_count: episode.agents.length,
      match_artifact: relativeMatchPaths.get(episode.index) ?? "",
      match_jsonl: relativeMatchJsonlPaths.get(episode.index) ?? "",
      error: episode.error ?? artifact?.failureReason ?? ""
    };
  });
}

function agentCsvRows(
  result: TournamentResult,
  artifactsByIndex: Map<number, MatchArtifact> = new Map(),
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const densityByActor = countSocialStepCommitsByActor(
      episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
    );
    return episode.agents.map((agent) => {
      const density = densityByActor.get(agent.playerId) ?? {
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      return {
        tournament_seed: result.seed,
        episode_index: episode.index,
        episode_seed: episode.seed,
        run_id: episode.runId ?? "",
        match_id: episode.matchId ?? "",
        status: episode.status,
        harness_status: episode.harnessStatus ?? "",
        player_id: agent.playerId,
        seat: agent.seat,
        profile_id: agent.profileId ?? "",
        model: agent.model,
        policy_name: agent.policyName ?? "",
        role: redactTruth ? "" : agent.role ?? "",
        team: redactTruth ? "" : agent.team ?? "",
        won: redactTruth ? "" : agent.won ?? "",
        reward: agent.reward ?? "",
        native_steps: density.nativeSteps,
        committed_steps: density.committedSteps,
        rejected_steps: density.rejectedSteps
      };
    });
  });
}

function metricCsvRows(result: TournamentResult, redactTruth = false): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => {
      const metadata =
        redactTruth && metric.metadata && typeof metric.metadata === "object"
          ? (() => {
              const { role: _role, team: _team, ...rest } = metric.metadata as Record<string, unknown>;
              return Object.keys(rest).length ? rest : undefined;
            })()
          : metric.metadata;
      // subject_id and scope remain; role/team truth lives mainly in subject/metadata
      // and is stripped from metrics.jsonl via aggregateMetricRecords. CSV keeps the
      // same column set so public packs do not invent new schema fields.
      void redactTruth;
      const promotion = resolveRecordedMetricPromotion(metric, promotionFallbackPolicyForReport(episode.evaluationReport));
      return {
        tournament_seed: result.seed,
        episode_index: episode.index,
        episode_seed: episode.seed,
        run_id: episode.runId ?? "",
        match_id: episode.matchId ?? "",
        status: episode.status,
        harness_status: episode.harnessStatus ?? "",
        metric_id: metric.id,
        label: metric.label,
        evaluator_id: metric.evaluatorId ?? "",
        evaluator_version: metric.evaluatorVersion ?? "",
        scope: metric.scope,
        subject_id: metric.subjectId ?? "",
        value: metric.value,
        unit: metric.unit ?? "",
        higher_is_better: metric.higherIsBetter ?? "",
        weight: metric.weight ?? "",
        denominator: metric.denominator ?? "",
        confidence: metric.confidence ?? "",
        aggregation: metric.aggregation ?? "",
        source: metric.source,
        scenario: metric.scenario ?? "",
        split: metric.split ?? "",
        evidence_ref_count: metric.evidenceRefs?.length ?? 0,
        promotion_class: promotion.promotionClass,
        scorecard_eligible: promotion.eligibleForScorecard,
        promotion_reasons: promotion.reasons.join("|"),
        promotion_decision_id: promotion.catalogDecisionId ?? "",
        metadata: metadata ? stableJson(metadata) : "",
        promotion_policy_id: promotion.policyId,
        promotion_policy_version: promotion.policyVersion,
        promotion_policy_hash: promotion.policyHash,
        promotion_catalog_id: promotion.catalogId,
        promotion_catalog_version: promotion.catalogVersion,
        promotion_catalog_hash: promotion.catalogHash,
        promotion_resolution: promotion.resolution
      };
    })
  );
}

function leaderboardCsvRows(
  rebuilt: RebuiltTournamentLeaderboard,
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return [
    ...Object.values(rebuilt.modelStats).map((stats) => ({
      subject_type: "model",
      subject_id: stats.model,
      model: stats.model,
      profile_id: "",
      policy_name: "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: redactTruth ? "" : stats.villageSeatGames,
      village_seat_wins: redactTruth ? "" : stats.villageSeatWins,
      werewolf_seat_games: redactTruth ? "" : stats.werewolfSeatGames,
      werewolf_seat_wins: redactTruth ? "" : stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      native_steps: stats.nativeSteps,
      committed_steps: stats.committedSteps,
      rejected_steps: stats.rejectedSteps,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    })),
    ...Object.values(rebuilt.profileStats).map((stats) => ({
      subject_type: "profile",
      subject_id: stats.profileId,
      model: stats.model,
      profile_id: stats.profileId,
      policy_name: stats.policyName ?? "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: redactTruth ? "" : stats.villageSeatGames,
      village_seat_wins: redactTruth ? "" : stats.villageSeatWins,
      werewolf_seat_games: redactTruth ? "" : stats.werewolfSeatGames,
      werewolf_seat_wins: redactTruth ? "" : stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      native_steps: stats.nativeSteps,
      committed_steps: stats.committedSteps,
      rejected_steps: stats.rejectedSteps,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    }))
  ];
}

type CsvCell = string | number | boolean | null | undefined;

const EPISODE_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "winner",
  "phase",
  "day",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "trajectory_steps",
  "message_count",
  "metric_count",
  "scorecard_eligible_metric_count",
  "scorecard_metric_count",
  "diagnostic_metric_count",
  "benchmark_only_metric_count",
  "warning_count",
  "warning_codes",
  "harness_error_count",
  "agent_count",
  "match_artifact",
  "match_jsonl",
  "error"
];

const AGENT_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "player_id",
  "seat",
  "profile_id",
  "model",
  "policy_name",
  "role",
  "team",
  "won",
  "reward",
  "native_steps",
  "committed_steps",
  "rejected_steps"
];

const METRIC_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "metric_id",
  "label",
  "evaluator_id",
  "evaluator_version",
  "scope",
  "subject_id",
  "value",
  "unit",
  "higher_is_better",
  "weight",
  "denominator",
  "confidence",
  "aggregation",
  "source",
  "scenario",
  "split",
  "evidence_ref_count",
  "promotion_class",
  "scorecard_eligible",
  "promotion_reasons",
  "promotion_decision_id",
  "metadata",
  "promotion_policy_id",
  "promotion_policy_version",
  "promotion_policy_hash",
  "promotion_catalog_id",
  "promotion_catalog_version",
  "promotion_catalog_hash",
  "promotion_resolution"
];

const LEADERBOARD_CSV_HEADERS = [
  "subject_type",
  "subject_id",
  "model",
  "profile_id",
  "policy_name",
  "seat_games",
  "seat_wins",
  "win_rate",
  "village_seat_games",
  "village_seat_wins",
  "werewolf_seat_games",
  "werewolf_seat_wins",
  "harness_turns",
  "harness_errors",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms",
  "reward_total",
  "average_reward"
];

function buildCsv(headers: string[], rows: Array<Record<string, CsvCell>>): string {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: CsvCell): string {
  if (value === undefined || value === null) return "";
  const redacted = redactSecrets(String(value));
  const text = typeof redacted === "string" ? redacted : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_No records._";
  const safeHeaders = headers.map(markdownTableCell);
  const safeRows = rows.map((row) => row.map(markdownTableCell));
  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function markdownTableCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === "string" ? redacted : value;
}

function ratio(numerator: number, denominator: number): string {
  return denominator ? String(round3(numerator / denominator)) : "0";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function writeJson(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(value)), null, 2)}\n`, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeJsonl(filePath: string, records: unknown[], overwrite: boolean): Promise<void> {
  const data = records.length
    ? `${records.map((record) => JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(record)))).join("\n")}\n`
    : "";
  await writeFile(filePath, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeText(filePath: string, value: string, overwrite: boolean): Promise<void> {
  const redacted = redactSecrets(value);
  await writeFile(filePath, typeof redacted === "string" ? redacted : value, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

function filesResult<TFiles extends TournamentArtifactFiles>(
  outputDir: string,
  files: TFiles
): TournamentArtifactWriteResult<TFiles> {
  return {
    outputDir,
    files
  };
}

function safeFileStem(value: string): string {
  const stem = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, "artifact");
  return stem || "artifact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
