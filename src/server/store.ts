import { createHash, randomUUID } from "node:crypto";
import { createGame } from "../core/engine";
import { DEFAULT_CONFIG } from "../core/roles";
import type { GameConfig, GameState, MatchMetrics } from "../core/types";
import type { AdversarialEvaluation, HarnessAgentProfile, HarnessEvaluationReport, HarnessStepRecord } from "../harness/types";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../harness/profiles";
import type { SocialEpisodeArtifact } from "../harness/social";
import type { HarnessCheckpoint, MatchArtifact } from "../harness/artifacts";
import type { TournamentArtifactWriteResult } from "../harness/tournamentArtifacts";

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

const matches = new Map<string, StoredMatch>();
const checkpoints = new Map<string, HarnessCheckpoint>();
const tournamentArtifactSets = new Map<string, StoredTournamentArtifactSet>();
const artifactRecoveryAudits = new Map<string, StoredArtifactRecoveryAuditRecord>();

export interface StoredTournamentArtifactFiles {
  manifest: string;
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
  matches: string[];
  matchesJsonl: string[];
}

export interface StoredTournamentArtifactSet {
  id: string;
  createdAt: string;
  experimentId: string;
  seed: string;
  outputDir: string;
  files: TournamentArtifactWriteResult["files"];
  relativeFiles: StoredTournamentArtifactFiles;
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
  matches.set(id, record);
  return record;
}

export function saveMatch(record: StoredMatch): void {
  matches.set(record.id, record);
}

export function getMatch(id: string): StoredMatch | undefined {
  return matches.get(id);
}

export function listMatches(): StoredMatch[] {
  return [...matches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  matches.set(id, record);
  return record;
}

export function saveCheckpoint(checkpoint: HarnessCheckpoint): void {
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
  tournamentArtifactSets.clear();
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
