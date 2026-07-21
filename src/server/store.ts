import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createGame } from "../core/engine";
import { DEFAULT_CONFIG } from "../core/roles";
import type { GameConfig, GameState, MatchMetrics } from "../core/types";
import type { AdversarialEvaluation, HarnessAgentProfile, HarnessEvaluationReport, HarnessStepRecord } from "../harness/types";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../harness/profiles";
import type { SocialEpisodeArtifact } from "../harness/social";
import {
  assertValidHarnessCheckpoint,
  assertValidMatchArtifactIntegrity,
  type HarnessCheckpoint,
  type MatchArtifact
} from "../harness/artifacts";
import type {
  PublicTournamentArtifactFiles,
  ResearchTournamentArtifactFiles,
  TournamentArtifactWriteResult
} from "../harness/tournamentArtifacts";
import type { ExperimentMatrixArtifactWriteResult } from "../harness/experimentMatrix";
import type { MatchComparisonArtifact } from "../harness/matchComparison";


export interface StoredMatch {
  id: string;
  createdAt: string;
  state: GameState;
  metrics?: MatchMetrics;
  artifact?: MatchArtifact;
  initialState?: GameState;
  trajectory?: HarnessStepRecord[];
  socialEpisode?: SocialEpisodeArtifact;
  evaluation?: AdversarialEvaluation;
  evaluationReport?: HarnessEvaluationReport;
  profiles?: HarnessAgentProfile[];
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments?: ResolvedAgentAssignment[];
  models: string[];
  status: "created" | "running" | "completed" | "failed";
  error?: string;
}

type StoredMatchEntry =
  | {
      lifecycle: "pre-artifact";
      record: Omit<StoredMatch, "artifact" | "metrics" | "initialState" | "trajectory" | "socialEpisode" | "evaluation" | "evaluationReport" | "profiles" | "assignment" | "resolvedAssignments">;
    }
  | {
      lifecycle: "finished";
      artifact: MatchArtifact;
    };

const matches = new Map<string, StoredMatchEntry>();
const checkpoints = new Map<string, HarnessCheckpoint>();
const comparisons = new Map<string, MatchComparisonArtifact>();
const tournamentArtifactSets = new Map<string, StoredTournamentArtifactSet>();
const experimentMatrixArtifactSets = new Map<string, StoredExperimentMatrixArtifactSet>();
const tournamentPublicShares = new Map<string, StoredTournamentPublicShare>();
const artifactRecoveryAudits = new Map<string, StoredArtifactRecoveryAuditRecord>();

export interface StoredTournamentArtifactFileBase {
  manifest: string;
  matches: string[];
}

export interface StoredResearchTournamentArtifactFiles extends StoredTournamentArtifactFileBase {
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

export interface StoredPublicTournamentArtifactFiles extends StoredTournamentArtifactFileBase {
  episodes: string;
}

export type StoredTournamentArtifactFiles = StoredResearchTournamentArtifactFiles | StoredPublicTournamentArtifactFiles;

export interface StoredTournamentArtifactSet {
  id: string;
  createdAt: string;
  experimentId: string;
  seed: string;
  outputDir: string;
  files: TournamentArtifactWriteResult<ResearchTournamentArtifactFiles | PublicTournamentArtifactFiles>["files"];
  relativeFiles: StoredTournamentArtifactFiles;
  nativeSteps?: number;
  committedSteps?: number;
  rejectedSteps?: number;
  metricCount?: number;
  scorecardEligibleMetricCount?: number;
  metricPromotionClassCounts?: {
    scorecard: number;
    diagnostic: number;
    benchmark_only: number;
  };
  scorecardEligibleMetricClassCounts?: {
    scorecard: number;
    diagnostic: number;
    benchmark_only: number;
  };
  projection?: {
    visibility: "research-full" | "postgame-research" | "public";
    matchArtifactView: "full" | "postgame-redacted" | "truth-redacted";
    assignmentTruthRedacted: boolean;
    publicShareSafe: boolean;
  };
}

/**
 * Only writer-produced, relative files are registered here.  The server uses
 * this allowlist for every matrix download; callers never receive outputDir.
 */
export interface StoredExperimentMatrixArtifactFiles {
  manifest: string;
  specNormalized: string;
  cells: string;
  statistics: string;
  summaryMarkdown: string;
  modelStatsCsv: string;
  profileStatsCsv: string;
  pairwiseModelComparisonsCsv: string;
  tournaments: Array<{
    cellId: string;
    manifest: string;
  }>;
}

export interface StoredExperimentMatrixArtifactSet {
  id: string;
  createdAt: string;
  matrixId: string;
  outputDir: string;
  files: ExperimentMatrixArtifactWriteResult["files"];
  relativeFiles: StoredExperimentMatrixArtifactFiles;
}

export interface StoredTournamentPublicShare {
  id: string;
  artifactSetId: string;
  createdAt: string;
  expiresAt: string | null;
  label?: string;
  /**
   * Optional allowlist of relative files from the artifact set.
   * When omitted, all registered files in the set are shareable.
   */
  relativeFiles?: string[];
  projection?: StoredTournamentArtifactSet["projection"];
  /** Number of successful public detail views. */
  detailViewCount: number;
  /** Number of successful public file downloads. */
  downloadCount: number;
  /** Per relative-file download histogram for successful public downloads. */
  downloadsByFile?: Record<string, number>;
  /** Bounded recent successful download events for time-series analytics. */
  downloadEvents?: Array<{ at: string; file: string }>;
  /** Bounded recent successful detail view timestamps for time-series analytics. */
  detailViewEvents?: string[];
  lastDetailViewedAt?: string | null;
  lastDownloadedAt?: string | null;
  lastDownloadedFile?: string | null;
}

export interface StoredArtifactRecoveryAuditRecord {
  id: string;
  createdAt: string;
  store: "match" | "checkpoint" | "tournament";
  source: "index" | "directory" | "manifest" | "sidecar";
  code: string;
  artifactId?: string;
  relativeFile?: string;
  detailKey?: string;
  message: string;
}

export function createMatchRecord(options: {
  seed?: string;
  config?: Partial<GameConfig> & { roles?: GameConfig["roles"] };
  models: string[];
}): StoredMatch {
  const id = randomUUID();
  const seed = options.seed ?? `arena-${new Date().toISOString()}-${id.slice(0, 8)}`;
  const state = createGame({
    id,
    seed,
    config: {
      ...DEFAULT_CONFIG,
      ...options.config
    }
  });
  const record: StoredMatch = {
    id,
    createdAt: new Date().toISOString(),
    state,
    models: options.models,
    status: "created"
  };
  saveMatch(record);
  return cloneJson(record);
}

export function saveMatch(record: StoredMatch): void {
  if (record.artifact) {
    assertValidMatchArtifactIntegrity(record.artifact);
    const artifactId = record.artifact.matchId ?? record.artifact.runId;
    if (artifactId !== record.id) {
      throw new Error(`Stored match id ${record.id} does not match artifact id ${artifactId}.`);
    }
    matches.set(record.id, {
      lifecycle: "finished",
      artifact: cloneJson(record.artifact)
    });
    return;
  }
  if (record.status === "completed") {
    throw new Error(`Completed match ${record.id} must contain a validated match artifact.`);
  }
  matches.set(record.id, {
    lifecycle: "pre-artifact",
    record: {
      id: record.id,
      createdAt: record.createdAt,
      state: cloneJson(record.state),
      models: [...record.models],
      status: record.status,
      error: record.error
    }
  });
}

export function getMatch(id: string): StoredMatch | undefined {
  const entry = matches.get(id);
  return entry ? materializeStoredMatch(entry) : undefined;
}

export function listMatches(): StoredMatch[] {
  return [...matches.values()].map(materializeStoredMatch).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createMatchRecordFromState(options: {
  state: GameState;
  models: string[];
  status?: StoredMatch["status"];
}): StoredMatch {
  const id = randomUUID();
  const record: StoredMatch = {
    id,
    createdAt: new Date().toISOString(),
    state: cloneJson(options.state),
    models: [...options.models],
    status: options.status ?? "created"
  };
  saveMatch(record);
  return cloneJson(record);
}

export function saveCheckpoint(checkpoint: HarnessCheckpoint): void {
  assertValidHarnessCheckpoint(checkpoint);
  checkpoints.set(checkpoint.checkpointId, cloneJson(checkpoint));
}

export function getCheckpoint(id: string): HarnessCheckpoint | undefined {
  const checkpoint = checkpoints.get(id);
  return checkpoint ? cloneJson(checkpoint) : undefined;
}

export function listCheckpoints(matchId?: string): HarnessCheckpoint[] {
  return [...checkpoints.values()]
    .filter((checkpoint) => {
      if (!matchId) return true;
      return checkpoint.source.matchId === matchId || checkpoint.source.runId === matchId;
    })
    .map((checkpoint) => cloneJson(checkpoint))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveComparison(comparison: MatchComparisonArtifact): void {
  if (comparison.artifactVersion !== "harness.match-comparison.v1" || comparison.kind !== "match-comparison") {
    throw new Error("Only harness.match-comparison.v1 comparison artifacts can be stored.");
  }
  if (!comparison.comparisonId || typeof comparison.comparisonId !== "string") {
    throw new Error("Comparison artifact is missing comparisonId.");
  }
  comparisons.set(comparison.comparisonId, cloneJson(comparison));
}

export function getComparison(id: string): MatchComparisonArtifact | undefined {
  const comparison = comparisons.get(id);
  return comparison ? cloneJson(comparison) : undefined;
}

export function listComparisons(options?: {
  baselineId?: string;
  candidateId?: string;
  /**
   * When provided with at least two ids, only return comparisons whose baseline
   * and candidate both intersect this pack/episode id set (matchId or runId).
   */
  packMatchIds?: Iterable<string>;
}): MatchComparisonArtifact[] {
  const packMatchIds = options?.packMatchIds
    ? options.packMatchIds instanceof Set
      ? options.packMatchIds
      : new Set(Array.from(options.packMatchIds).filter((value) => typeof value === "string" && value.length > 0))
    : null;
  return [...comparisons.values()]
    .filter((comparison) => {
      if (options?.baselineId) {
        const baselineId = options.baselineId;
        const matchesBaseline =
          comparison.baseline.matchId === baselineId || comparison.baseline.runId === baselineId;
        if (!matchesBaseline) return false;
      }
      if (options?.candidateId) {
        const candidateId = options.candidateId;
        const matchesCandidate =
          comparison.candidate.matchId === candidateId || comparison.candidate.runId === candidateId;
        if (!matchesCandidate) return false;
      }
      if (packMatchIds && packMatchIds.size >= 2) {
        const baselineIds = [comparison.baseline.matchId, comparison.baseline.runId].filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );
        const candidateIds = [comparison.candidate.matchId, comparison.candidate.runId].filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );
        const baselineInPack = baselineIds.some((id) => packMatchIds.has(id));
        const candidateInPack = candidateIds.some((id) => packMatchIds.has(id));
        if (!baselineInPack || !candidateInPack) return false;
      }
      return true;
    })
    .map((comparison) => cloneJson(comparison))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


export function countCheckpointsForMatch(matchId: string): number {
  return listCheckpoints(matchId).length;
}

export function saveTournamentArtifactSet(set: StoredTournamentArtifactSet): void {
  tournamentArtifactSets.set(set.id, cloneJson(set));
}

export function getTournamentArtifactSet(id: string): StoredTournamentArtifactSet | undefined {
  const set = tournamentArtifactSets.get(id);
  return set ? cloneJson(set) : undefined;
}

export function listTournamentArtifactSets(): StoredTournamentArtifactSet[] {
  return [...tournamentArtifactSets.values()].map((set) => cloneJson(set)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveExperimentMatrixArtifactSet(set: StoredExperimentMatrixArtifactSet): void {
  experimentMatrixArtifactSets.set(set.id, cloneJson(set));
}

export function getExperimentMatrixArtifactSet(id: string): StoredExperimentMatrixArtifactSet | undefined {
  const set = experimentMatrixArtifactSets.get(id);
  return set ? cloneJson(set) : undefined;
}

export function listExperimentMatrixArtifactSets(): StoredExperimentMatrixArtifactSet[] {
  return [...experimentMatrixArtifactSets.values()]
    .map((set) => cloneJson(set))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface TournamentPublicShareEventRetentionPolicy {
  maxEvents: number;
  /** When null/undefined, age-based pruning is disabled. */
  maxAgeMs?: number | null;
}

export const DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION: TournamentPublicShareEventRetentionPolicy = {
  maxEvents: 100,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000
};

export function retainTimestampEvents(
  events: string[] | undefined,
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): string[] {
  const maxEvents = Math.max(1, Math.floor(policy.maxEvents || 1));
  const maxAgeMs = policy.maxAgeMs;
  const cutoff = typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? now - maxAgeMs : null;
  const kept: string[] = [];
  for (const event of events ?? []) {
    if (typeof event !== "string") continue;
    const ms = Date.parse(event);
    if (!Number.isFinite(ms)) continue;
    if (cutoff !== null && ms < cutoff) continue;
    kept.push(event);
  }
  return kept.slice(-maxEvents);
}

export function retainDownloadEvents(
  events: Array<{ at: string; file: string }> | undefined,
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): Array<{ at: string; file: string }> {
  const maxEvents = Math.max(1, Math.floor(policy.maxEvents || 1));
  const maxAgeMs = policy.maxAgeMs;
  const cutoff = typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? now - maxAgeMs : null;
  const kept: Array<{ at: string; file: string }> = [];
  for (const event of events ?? []) {
    if (!event || typeof event.at !== "string" || typeof event.file !== "string" || !event.file) continue;
    const ms = Date.parse(event.at);
    if (!Number.isFinite(ms)) continue;
    if (cutoff !== null && ms < cutoff) continue;
    kept.push({ at: event.at, file: event.file });
  }
  return kept.slice(-maxEvents);
}

export function pruneTournamentPublicShareEvents(
  share: StoredTournamentPublicShare,
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): StoredTournamentPublicShare {
  return {
    ...cloneJson(share),
    detailViewEvents: retainTimestampEvents(share.detailViewEvents, policy, now),
    downloadEvents: retainDownloadEvents(share.downloadEvents, policy, now)
  };
}

export function createTournamentPublicShare(input: {
  artifactSetId: string;
  expiresAt?: string | null;
  label?: string;
  relativeFiles?: string[];
  projection?: StoredTournamentArtifactSet["projection"];
  createdAt?: string;
}): StoredTournamentPublicShare {
  const share: StoredTournamentPublicShare = {
    id: randomBytes(24).toString("hex"),
    artifactSetId: input.artifactSetId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
    label: input.label,
    relativeFiles: input.relativeFiles ? [...input.relativeFiles] : undefined,
    projection: input.projection,
    detailViewCount: 0,
    downloadCount: 0,
    downloadsByFile: {},
    downloadEvents: [],
    detailViewEvents: [],
    lastDetailViewedAt: null,
    lastDownloadedAt: null,
    lastDownloadedFile: null
  };
  tournamentPublicShares.set(share.id, cloneJson(share));
  return cloneJson(share);
}

export function recordTournamentPublicShareDetailView(
  id: string,
  viewedAt = new Date().toISOString(),
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): StoredTournamentPublicShare | undefined {
  const current = tournamentPublicShares.get(id);
  if (!current) return undefined;
  const detailViewEvents = retainTimestampEvents([...(current.detailViewEvents ?? []), viewedAt], policy, now);
  const next: StoredTournamentPublicShare = {
    ...cloneJson(current),
    detailViewCount: Math.max(0, current.detailViewCount ?? 0) + 1,
    detailViewEvents,
    lastDetailViewedAt: viewedAt
  };
  tournamentPublicShares.set(id, next);
  return cloneJson(next);
}

export function recordTournamentPublicShareDownload(
  id: string,
  relativeFile: string,
  downloadedAt = new Date().toISOString(),
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): StoredTournamentPublicShare | undefined {
  const current = tournamentPublicShares.get(id);
  if (!current) return undefined;
  const downloadsByFile = { ...(current.downloadsByFile ?? {}) };
  downloadsByFile[relativeFile] = Math.max(0, downloadsByFile[relativeFile] ?? 0) + 1;
  const downloadEvents = retainDownloadEvents(
    [...(current.downloadEvents ?? []), { at: downloadedAt, file: relativeFile }],
    policy,
    now
  );
  const next: StoredTournamentPublicShare = {
    ...cloneJson(current),
    downloadCount: Math.max(0, current.downloadCount ?? 0) + 1,
    downloadsByFile,
    downloadEvents,
    lastDownloadedAt: downloadedAt,
    lastDownloadedFile: relativeFile
  };
  tournamentPublicShares.set(id, next);
  return cloneJson(next);
}

export function saveTournamentPublicShare(share: StoredTournamentPublicShare): void {
  tournamentPublicShares.set(share.id, cloneJson(share));
}

export function getTournamentPublicShare(id: string): StoredTournamentPublicShare | undefined {
  const share = tournamentPublicShares.get(id);
  return share ? cloneJson(share) : undefined;
}

export function listTournamentPublicShares(artifactSetId?: string): StoredTournamentPublicShare[] {
  return [...tournamentPublicShares.values()]
    .filter((share) => (artifactSetId ? share.artifactSetId === artifactSetId : true))
    .map((share) => cloneJson(share))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pruneAllTournamentPublicShareEvents(
  policy: TournamentPublicShareEventRetentionPolicy = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  now = Date.now()
): { prunedShareCount: number; removedDetailViewEvents: number; removedDownloadEvents: number } {
  let prunedShareCount = 0;
  let removedDetailViewEvents = 0;
  let removedDownloadEvents = 0;
  for (const [id, share] of tournamentPublicShares.entries()) {
    const beforeDetail = share.detailViewEvents?.length ?? 0;
    const beforeDownload = share.downloadEvents?.length ?? 0;
    const pruned = pruneTournamentPublicShareEvents(share, policy, now);
    const afterDetail = pruned.detailViewEvents?.length ?? 0;
    const afterDownload = pruned.downloadEvents?.length ?? 0;
    if (beforeDetail !== afterDetail || beforeDownload !== afterDownload) {
      tournamentPublicShares.set(id, pruned);
      prunedShareCount += 1;
      removedDetailViewEvents += Math.max(0, beforeDetail - afterDetail);
      removedDownloadEvents += Math.max(0, beforeDownload - afterDownload);
    }
  }
  return { prunedShareCount, removedDetailViewEvents, removedDownloadEvents };
}

export function deleteTournamentPublicShare(id: string): boolean {
  return tournamentPublicShares.delete(id);
}

export function saveArtifactRecoveryAuditRecord(
  record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string }
): StoredArtifactRecoveryAuditRecord | undefined {
  const id = artifactRecoveryAuditId(record);
  if (artifactRecoveryAudits.has(id)) return undefined;
  const stored = {
    ...cloneJson(record),
    id,
    createdAt: record.createdAt ?? new Date().toISOString()
  };
  artifactRecoveryAudits.set(id, stored);
  return cloneJson(stored);
}

export function listArtifactRecoveryAuditRecords(): StoredArtifactRecoveryAuditRecord[] {
  return [...artifactRecoveryAudits.values()].map((record) => cloneJson(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function clearServerStoreForTests(): void {
  matches.clear();
  checkpoints.clear();
  comparisons.clear();
  tournamentArtifactSets.clear();
  experimentMatrixArtifactSets.clear();
  tournamentPublicShares.clear();
  artifactRecoveryAudits.clear();
}

function artifactRecoveryAuditId(record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt">): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        record.store,
        record.source,
        record.code,
        record.artifactId ?? null,
        record.relativeFile ?? null,
        record.detailKey ?? null
      ])
    )
    .digest("hex")
    .slice(0, 24);
  return `artifact-recovery:${digest}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function materializeStoredMatch(entry: StoredMatchEntry): StoredMatch {
  if (entry.lifecycle === "pre-artifact") return cloneJson(entry.record);
  const artifact = cloneJson(entry.artifact);
  return {
    id: artifact.matchId ?? artifact.runId,
    createdAt: artifact.createdAt,
    state: artifact.finalState,
    metrics: artifact.metrics,
    artifact,
    initialState: artifact.initialState,
    trajectory: artifact.trajectory,
    socialEpisode: artifact.socialEpisode,
    evaluation: artifact.evaluation,
    evaluationReport: artifact.evaluationReport,
    profiles: artifact.profiles,
    assignment: artifact.assignment,
    resolvedAssignments: artifact.resolvedAssignments,
    models: artifact.models,
    status: artifact.status === "failed" ? "failed" : "completed",
    error: artifact.failureReason
  };
}
