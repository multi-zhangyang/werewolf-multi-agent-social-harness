import path from "node:path";
import { modelClientFromEnv } from "../agents/providerRegistry";
import { hashStableState } from "../harness/hash";
import { OpenAIHarnessReasoner } from "../harness/reasoner";
import type { TournamentResult } from "../harness/tournament";
import type { HarnessReasoner, WerewolfLivePublicState } from "../harness/types";
import { isPersistedMatchArtifactId } from "./artifactFiles";
import { getTournamentArtifactSetForBaseDir } from "./artifactSetStore";
import { loadCheckpointArtifactIndex, loadCheckpointForkAttemptStore } from "./checkpointArtifactStore";
import { loadComparisonArtifactIndex } from "./comparisonArtifactStore";
import { normalizeOptionalDirectory } from "./httpValidation";
import {
  matchArtifactId,
  persistMatchArtifact,
  recoverMatchArtifactIndex,
  storedMatchFromMatchArtifact,
  writeMatchArtifactIndex
} from "./matchArtifactStore";
import {
  type StoredTournamentArtifactSet,
  type StoredTournamentPublicShare,
  type TournamentPublicShareEventRetentionPolicy,
  saveMatch
} from "./store";
import {
  resolvePublicShareDownloadRateLimit,
  resolvePublicShareEventRetention,
  setActivePublicShareEventRetention
} from "./tournamentShares";

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";

export interface ServerAppDependencies {
  createReasoner?: (abortSignal: AbortSignal) => HarnessReasoner;
  /**
   * Actual listener host when embedding the app. Full artifacts remain local
   * debug-only and are denied unless this is a loopback bind target.
   */
  artifactAccessBindHost?: string;
  tournamentArtifactBaseDir?: string;
  /** Durable V2 experiment run/episode authority used by production
   * tournament and matrix execution. */
  experimentRunBaseDir?: string;
  matrixArtifactBaseDir?: string;
  checkpointArtifactBaseDir?: string;
  matchArtifactBaseDir?: string;
  comparisonArtifactBaseDir?: string;
  /**
   * Optional override for public share download rate limiting.
   * Defaults come from TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_LIMIT /
   * TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_WINDOW_MS.
   */
  publicShareDownloadRateLimit?: {
    maxDownloads: number;
    windowMs: number;
    now?: () => number;
  };
  /**
   * Optional override for public-share analytics event retention.
   * Defaults:
   * - TOURNAMENT_PUBLIC_SHARE_EVENT_MAX=100
   * - TOURNAMENT_PUBLIC_SHARE_EVENT_MAX_AGE_MS=2592000000 (30d)
   */
  publicShareEventRetention?: TournamentPublicShareEventRetentionPolicy;
}

export interface RunningMatchLiveProjection {
  artifactVersion: "server.match-live-projection.v1";
  kind: "match-live-projection";
  matchId: string;
  lifecycle: "running";
  artifactAvailable: false;
  projection: {
    view: "live-public";
    privateEvidenceRedacted: true;
    postgameTruthRedacted: true;
  };
  publicState: WerewolfLivePublicState;
}

/**
 * Explicit acknowledgement for a browser that opts into the live spectator
 * lifecycle. This must remain separate from `serializeStoredMatch()`: the
 * latter is an operator registry summary and carries metadata that would be a
 * live timing/model side channel when rendered beside the strict table.
 */
export interface LiveMatchStartResponse {
  artifactVersion: "server.match-live-start.v1";
  kind: "match-live-start";
  matchId: string;
  lifecycle: "running";
  artifactAvailable: false;
  projection: {
    view: "live-public";
    privateEvidenceRedacted: true;
    postgameTruthRedacted: true;
  };
}

export interface TerminalMatchLiveProjection {
  artifactVersion: "server.match-live-projection.v1";
  kind: "match-live-projection";
  matchId: string;
  /**
   * A process restart can discard the ephemeral frame while a persisted match
   * record still says running. Report that honestly without inventing a local
   * public state or misclassifying the run as failed.
   */
  lifecycle: "running" | "completed" | "truncated" | "failed";
  artifactAvailable: boolean;
}

export type MatchLiveProjection = RunningMatchLiveProjection | TerminalMatchLiveProjection;

export interface ServerContext {
  artifactAccessBindHost: string;
  createReasoner: (abortSignal: AbortSignal) => HarnessReasoner;
  tournamentArtifactBaseDir: string | undefined;
  experimentRunBaseDir: string | undefined;
  matrixArtifactBaseDir: string | undefined;
  checkpointArtifactBaseDir: string | undefined;
  matchArtifactBaseDir: string | undefined;
  comparisonArtifactBaseDir: string | undefined;
  publicShareDownloadRateLimit: { maxDownloads: number; windowMs: number; now: () => number };
  publicShareEventRetention: TournamentPublicShareEventRetentionPolicy;
  liveMatchProjections: Map<string, RunningMatchLiveProjection>;
  setLiveProjection: (matchId: string, publicState: WerewolfLivePublicState) => void;
  publicShareDownloadBuckets: Map<string, number[]>;
  loadServerArtifactStores: () => Promise<void>;
  loadMatchArtifactIndex: (baseDir: string | undefined) => Promise<void>;
  registerTournamentMatchArtifacts: (result: TournamentResult) => Promise<void>;
  publicTournamentArtifactSetForShare: (share: StoredTournamentPublicShare) => StoredTournamentArtifactSet | undefined;
}

export function createServerContext(dependencies: ServerAppDependencies = {}): ServerContext {
const artifactAccessBindHost = dependencies.artifactAccessBindHost ?? host;
const createReasoner =
  dependencies.createReasoner ??
  ((abortSignal: AbortSignal): HarnessReasoner =>
    OpenAIHarnessReasoner.forLiveProvider(modelClientFromEnv(process.env, { abortSignal })));
const tournamentArtifactBaseDir = normalizeOptionalDirectory(dependencies.tournamentArtifactBaseDir ?? process.env.TOURNAMENT_ARTIFACT_BASE_DIR);
const experimentRunBaseDir = normalizeOptionalDirectory(
  dependencies.experimentRunBaseDir ??
    process.env.EXPERIMENT_RUN_BASE_DIR ??
    (tournamentArtifactBaseDir ? path.join(tournamentArtifactBaseDir, ".experiment-runs") : undefined)
);
/** Keep matrix directories outside the tournament root so recovery scans have one artifact schema per root. */
const matrixArtifactBaseDir = normalizeOptionalDirectory(
  dependencies.matrixArtifactBaseDir ??
    process.env.MATRIX_ARTIFACT_BASE_DIR ??
    (tournamentArtifactBaseDir ? path.join(tournamentArtifactBaseDir, "matrices") : undefined)
);
const checkpointArtifactBaseDir = normalizeOptionalDirectory(dependencies.checkpointArtifactBaseDir ?? process.env.CHECKPOINT_ARTIFACT_BASE_DIR);
const matchArtifactBaseDir = normalizeOptionalDirectory(dependencies.matchArtifactBaseDir ?? process.env.MATCH_ARTIFACT_BASE_DIR);
let matchArtifactStoreLoad: Promise<void> | undefined;
const comparisonArtifactBaseDir = normalizeOptionalDirectory(
  dependencies.comparisonArtifactBaseDir ?? process.env.COMPARISON_ARTIFACT_BASE_DIR
);
const publicShareDownloadRateLimit = resolvePublicShareDownloadRateLimit(
  dependencies.publicShareDownloadRateLimit,
  process.env
);
const publicShareEventRetention = resolvePublicShareEventRetention(
  dependencies.publicShareEventRetention,
  process.env
);
// Running-table projections are ephemeral API views. They must never become a
// match artifact, replay/checkpoint source, or store-owned canonical state.
const liveMatchProjections = new Map<string, RunningMatchLiveProjection>();
// Hash of each stored projection's publicState, keyed by the projection
// object itself so a deleted/replaced projection can never reuse a stale
// hash. Avoids re-hashing the previous state on every scheduler update.
const liveProjectionStateHashes = new WeakMap<RunningMatchLiveProjection, string>();

const setLiveProjection = (matchId: string, publicState: WerewolfLivePublicState): void => {
  const current = liveMatchProjections.get(matchId);
  const state = structuredClone(publicState);
  // Safe-state equality, rather than a receipt/batch counter, prevents
  // private night actions and parallel receipt fan-out becoming a cadence
  // side-channel in the public revision number.
  const nextHash = hashStableState(state);
  if (current) {
    const currentHash = liveProjectionStateHashes.get(current) ?? hashStableState(current.publicState);
    if (currentHash === nextHash) return;
  }
  const next: RunningMatchLiveProjection = {
    artifactVersion: "server.match-live-projection.v1",
    kind: "match-live-projection",
    matchId,
    lifecycle: "running",
    artifactAvailable: false,
    projection: {
      view: "live-public",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    },
    publicState: state
  };
  liveProjectionStateHashes.set(next, nextHash);
  liveMatchProjections.set(matchId, next);
};
setActivePublicShareEventRetention(publicShareEventRetention);
const publicShareDownloadBuckets = new Map<string, number[]>();

async function loadServerArtifactStores(): Promise<void> {
  await loadMatchArtifactIndex(matchArtifactBaseDir);
  await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
  await loadCheckpointForkAttemptStore(checkpointArtifactBaseDir);
  await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
}

async function loadMatchArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  matchArtifactStoreLoad ??= recoverMatchArtifactIndex(baseDir).catch((error) => {
    matchArtifactStoreLoad = undefined;
    throw error;
  });
  await matchArtifactStoreLoad;
}

async function registerTournamentMatchArtifacts(result: TournamentResult): Promise<void> {
  const records = result.artifacts ?? [];
  if (!records.length) return;
  let wroteDiskArtifact = false;
  for (const record of records) {
    const artifact = record.artifact;
    saveMatch(storedMatchFromMatchArtifact(artifact));
    const id = matchArtifactId(artifact);
    if (!matchArtifactBaseDir || !isPersistedMatchArtifactId(id)) continue;
    try {
      await persistMatchArtifact(artifact, matchArtifactBaseDir);
      wroteDiskArtifact = true;
    } catch {
      // Keep memory registration even if disk persistence is unavailable.
    }
  }
  if (wroteDiskArtifact) {
    await writeMatchArtifactIndex(matchArtifactBaseDir);
  }
}

function publicTournamentArtifactSetForShare(share: StoredTournamentPublicShare): StoredTournamentArtifactSet | undefined {
  const set = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
  return set && !("registry" in set.relativeFiles) ? set : undefined;
}

return {
  artifactAccessBindHost,
  createReasoner,
  tournamentArtifactBaseDir,
  experimentRunBaseDir,
  matrixArtifactBaseDir,
  checkpointArtifactBaseDir,
  matchArtifactBaseDir,
  comparisonArtifactBaseDir,
  publicShareDownloadRateLimit,
  publicShareEventRetention,
  liveMatchProjections,
  setLiveProjection,
  publicShareDownloadBuckets,
  loadServerArtifactStores,
  loadMatchArtifactIndex,
  registerTournamentMatchArtifacts,
  publicTournamentArtifactSetForShare
};
}
