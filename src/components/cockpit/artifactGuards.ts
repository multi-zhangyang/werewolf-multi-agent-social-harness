import {
  isMatchComparisonSelectionCurrent,
  type MatchComparisonArtifact
} from "../../harness/matchComparisonView";
import type { PostgameReplayFrameDto } from "../../server/artifactProjection";
import { WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS } from "../../harness/types";
import type {
  ArtifactView,
  ComparisonRequestContext,
  ProjectedMatchArtifact,
  ProjectedSocialStep
} from "./cockpitTypes";
import { isRecord, shortId } from "./formatters";

export async function assertServerProjectedArtifact(artifact: ProjectedMatchArtifact, label: string): Promise<void> {
  const { assertServerProjectedArtifactContract } = await import("./socialNetworkContract");
  assertServerProjectedArtifactContract(artifact, label);
}

export function assertArtifactMatchesId(artifact: ProjectedMatchArtifact, id: string, label: string): void {
  // This public DTO intentionally omits seed-derived run identity. The request
  // URL, not an echoed canonical id, correlates a truth-redacted response.
  if (artifact.projection.view === "truth-redacted") {
    if (artifact.runId || artifact.matchId || artifact.seed) {
      throw new Error(`${label} truth-redacted projection must not expose canonical identity.`);
    }
    return;
  }
  if (artifact.runId !== id && artifact.matchId !== id) {
    throw new Error(`${label} identity mismatch: expected ${shortId(id)}, got ${shortId(artifact.matchId ?? artifact.runId)}.`);
  }
}

/**
 * This verifies only server response shape and its binding to the already
 * recorded native boundary. The browser deliberately does not apply commands
 * or recompute a hash from a redacted state projection.
 */
export function assertServerReplayFrame(frame: PostgameReplayFrameDto, step: ProjectedSocialStep, nativeStepCount: number): void {
  if (
    frame.artifactVersion !== "server.match-replay-frame.v1" ||
    frame.kind !== "match-replay-frame" ||
    frame.authority !== "native-social-episode" ||
    frame.source !== "server-owned-match-artifact"
  ) {
    throw new Error("Replay frame is not a server-owned native replay projection.");
  }
  if (
    frame.projection?.view !== "postgame-redacted" ||
    frame.projection.privateEvidenceRedacted !== true ||
    frame.projection.postgameTruthRedacted !== false
  ) {
    throw new Error("Replay frame must be a postgame-redacted projection.");
  }
  if (frame.cursor.nativeStepCount !== nativeStepCount) {
    throw new Error("Replay frame cursor does not match the requested native step.");
  }
  if (!isRecord(frame.state)) {
    throw new Error("Replay frame is missing a server-projected state.");
  }
  if (step.postStateHash && frame.cursor.recordedPostStateHash !== step.postStateHash) {
    throw new Error("Replay frame recorded state hash does not match the selected native step.");
  }
  if (step.postStateHash && frame.cursor.stateHash !== undefined && frame.cursor.stateHash !== step.postStateHash) {
    throw new Error("Replay frame deterministic state hash does not match the selected native step.");
  }
}

export function assertServerProjectedComparison(comparison: MatchComparisonArtifact): void {
  if (
    (comparison.projection.view !== "postgame-redacted" && comparison.projection.view !== "truth-redacted") ||
    comparison.projection.privateEvidenceRedacted !== true
  ) {
    throw new Error("comparison artifact must be a postgame-redacted or truth-redacted projection.");
  }
  if (comparison.projection.view === "truth-redacted" && comparison.projection.postgameTruthRedacted !== true) {
    throw new Error("truth-redacted comparison must set postgameTruthRedacted=true.");
  }
}

export function assertComparisonMatchesIds(comparison: MatchComparisonArtifact, baselineId: string, candidateId: string): void {
  // Truth-redacted comparison sources also omit both canonical ids. Their pair
  // identity is owned by the server route that produced this response.
  if (comparison.projection.view === "truth-redacted") {
    const sources = [comparison.baseline, comparison.candidate];
    if (sources.some((source) => source.runId || source.matchId || source.seed)) {
      throw new Error("truth-redacted comparison must not expose canonical source identity.");
    }
    return;
  }
  const baselineMatches = comparison.baseline.runId === baselineId || comparison.baseline.matchId === baselineId;
  const candidateMatches = comparison.candidate.runId === candidateId || comparison.candidate.matchId === candidateId;
  if (!baselineMatches || !candidateMatches) {
    throw new Error(`comparison identity mismatch: expected ${shortId(baselineId)} vs ${shortId(candidateId)}.`);
  }
}

export function isComparisonCurrentForRoute(options: {
  comparison: MatchComparisonArtifact | null | undefined;
  context: ComparisonRequestContext | null | undefined;
  baselineId?: string | null;
  candidateId?: string | null;
  view?: ArtifactView | null;
}): boolean {
  const baselineId = options.baselineId?.trim() ?? "";
  const candidateId = options.candidateId?.trim() ?? "";
  const comparison = options.comparison;
  if (!comparison || !baselineId || !candidateId || !options.view) return false;
  if (comparison.view !== options.view) return false;
  if (comparison.view !== "truth-redacted") {
    return isMatchComparisonSelectionCurrent({
      comparison,
      baselineId,
      candidateId,
      view: options.view
    });
  }
  const context = options.context;
  return Boolean(
    context &&
      context.comparisonId === comparison.comparisonId &&
      context.baselineId === baselineId &&
      context.candidateId === candidateId &&
      context.view === options.view
  );
}

/**
 * The Werewolf adapter has a concrete lower bound for its first parallel
 * native batch. Keep the preflight identical for a one-off match and a
 * tournament public-pack run so the UI never advertises a scheduler that the
 * server must reject before an experiment can start.
 */
export function assertJointPhaseSchedulerTransitionBudget(
  scheduler: "aec-batched-decision" | "parallel",
  transitions: number | undefined
): void {
  if (scheduler !== "parallel" || transitions === undefined || transitions >= WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS) return;
  throw new Error(
    `parallel 联合阶段需要 maxTransitions >= ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS}（system.advance + seer.inspect + 双狼 joint batch）。`
  );
}
