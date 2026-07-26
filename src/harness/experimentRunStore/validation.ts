import { createHash } from "node:crypto";
import { validateGenericExperimentProvenance } from "../experimentSpec";
import type { GenericTournamentRunSetArtifact } from "../genericTournamentArtifacts";
import { hashStableJsonValue } from "../hash";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "../tournamentRunner";
import {
  DIRECTORY_KEY_PATTERN,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  MANIFEST_FILE,
  RECORD_FILE,
  type GenericEpisodeEnvelope,
  type HarnessExperimentEpisodeRetryCode,
  type HarnessExperimentRunCurrentEpisodeV2,
  type HarnessExperimentRunCurrentEpisodeV3,
  type HarnessExperimentRunEpisodeReferenceV1,
  type HarnessExperimentRunEpisodeReferenceV3,
  type HarnessExperimentRunManifest,
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunRecordV2,
  type HarnessExperimentRunRecordV3,
  type HarnessExperimentRunRecovery,
  type HarnessExperimentRunRetriedAttemptV3,
  type HarnessExperimentRunRetryWaitEpisodeV3,
  type HarnessExperimentRunStagedEpisodeV3,
  type HarnessExperimentRunStartedEpisodeV3,
  type HarnessExperimentRunStoreEntry,
  type HarnessExperimentRunTerminalAttemptV3
} from "./types";

export function assertRunRecord(record: HarnessExperimentRunRecord): void {
  assertExactKeys(record, [
    "schemaVersion", "kind", "state", "runSetId", "createdAt", "updatedAt", "experiment",
    "gamesRequested", "gamesCompleted", "gamesTruncated", "gamesFailed", "gamesInFlight", "gamesUnstarted", "episodes",
    "currentEpisode"
  ], "Experiment run record");
  if (
    (record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION &&
      record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
      record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) ||
    record.kind !== "experiment-run-record"
  ) {
    throw new Error("Experiment run record version or kind is invalid.");
  }
  if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION && ("gamesInFlight" in record || "currentEpisode" in record)) {
    throw new Error("Experiment run v1 record contains v2 lifecycle fields.");
  }
  assertIdentifier(record.runSetId, "runSetId");
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new Error("Experiment run updatedAt cannot precede createdAt.");
  }
  if (record.state !== "active" && record.state !== "finalized") throw new Error("Experiment run state is invalid.");
  const provenanceErrors = validateGenericExperimentProvenance(record.experiment);
  if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
  if (
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 && record.experiment.spec.retryPolicy.maxAttempts !== 1) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && record.experiment.spec.retryPolicy.maxAttempts <= 1)
  ) throw new Error("Experiment run record schema does not match retryPolicy.maxAttempts.");
  if (!Array.isArray(record.episodes)) throw new Error("Experiment run episodes must be an array.");
  if (record.gamesRequested !== record.experiment.spec.episodeCount) throw new Error("Experiment run gamesRequested does not match provenance.");
  const counts = [record.gamesRequested, record.gamesCompleted, record.gamesTruncated, record.gamesFailed, record.gamesUnstarted];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) throw new Error("Experiment run lifecycle counts must be non-negative integers.");
  const gamesInFlight = isAttemptRecord(record) ? record.gamesInFlight : 0;
  if (record.gamesCompleted + record.gamesTruncated + record.gamesFailed + gamesInFlight + record.gamesUnstarted !== record.gamesRequested) {
    throw new Error("Experiment run lifecycle counts do not cover the requested schedule.");
  }
  if (record.episodes.length !== record.gamesRequested - record.gamesUnstarted - gamesInFlight) throw new Error("Experiment run episode count mismatch.");
  if (isAttemptRecord(record)) {
    if (!("gamesInFlight" in record)) throw new Error("Experiment run attempt record is missing gamesInFlight.");
    if (record.gamesInFlight !== 0 && record.gamesInFlight !== 1) throw new Error("Experiment run gamesInFlight is invalid.");
    if ((record.currentEpisode === undefined) !== (record.gamesInFlight === 0)) throw new Error("Experiment run in-flight count does not match currentEpisode.");
    if (record.state === "finalized" && record.currentEpisode) throw new Error("Finalized experiment run cannot retain an in-flight episode.");
    if (record.currentEpisode) {
      if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) assertCurrentEpisodeV3(record.currentEpisode, record);
      else assertCurrentEpisodeV2(record.currentEpisode, record);
    }
  }
  const lifecycleCounts = { completed: 0, truncated: 0, failed: 0 };
  const runIds = new Set<string>();
  for (const [position, episode] of record.episodes.entries()) {
    assertExactKeys(episode, [
      "index", "seed", "status", "runId", "artifactSha256", "metricCount", "failureCount", "error"
      , "evaluationReportId", "evaluationReportSha256", "attempts", "acceptedAttemptId"
    ], `Experiment run episode ${position}`);
    if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
      assertTerminalEpisodeAttemptsV3(episode as HarnessExperimentRunEpisodeReferenceV3, record, position);
    } else if ("attempts" in episode || "acceptedAttemptId" in episode) {
      throw new Error("Only an experiment run v3 episode may retain an attempt ledger.");
    }
    if (episode.index !== position || episode.seed !== `${record.experiment.spec.seed}:g${position + 1}`) {
      throw new Error("Experiment run episode ordering or seed is invalid.");
    }
    if (episode.status !== "completed" && episode.status !== "truncated" && episode.status !== "failed") {
      throw new Error("Experiment run episode lifecycle is invalid.");
    }
    if (
      !Number.isInteger(episode.metricCount) || episode.metricCount < 0 ||
      !Number.isInteger(episode.failureCount) || episode.failureCount < 0
    ) {
      throw new Error("Experiment episode sidecar counts must be non-negative integers.");
    }
    if (episode.runId) {
      assertIdentifier(episode.runId, `episodes[${position}].runId`);
      if (runIds.has(episode.runId)) throw new Error("Experiment episode runId references must be unique.");
      runIds.add(episode.runId);
      if (!episode.artifactSha256 || !DIRECTORY_KEY_PATTERN.test(episode.artifactSha256)) {
        throw new Error("Experiment episode reference is missing a valid artifact digest.");
      }
      if ((episode.evaluationReportId === undefined) !== (episode.evaluationReportSha256 === undefined)) {
        throw new Error("Experiment episode evaluation report reference is incomplete.");
      }
      if (episode.evaluationReportId !== undefined) {
        assertIdentifier(episode.evaluationReportId, `episodes[${position}].evaluationReportId`);
        if (!DIRECTORY_KEY_PATTERN.test(episode.evaluationReportSha256!)) {
          throw new Error("Experiment episode evaluation report digest is invalid.");
        }
      }
    } else {
      if (episode.status !== "failed") throw new Error("Only a failed episode may lack a canonical artifact reference.");
      if (
        episode.artifactSha256 || episode.metricCount || episode.failureCount ||
        episode.evaluationReportId || episode.evaluationReportSha256
      ) {
        throw new Error("Pre-artifact experiment failure cannot claim canonical episode sidecars.");
      }
    }
    if (episode.status === "failed") {
      if (episode.error !== GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE) {
        throw new Error("Failed experiment episode must use the reviewed failure message.");
      }
    } else if (episode.error !== undefined) {
      throw new Error("Successful experiment episode cannot carry a failure message.");
    }
    lifecycleCounts[episode.status] += 1;
  }
  if (
    lifecycleCounts.completed !== record.gamesCompleted ||
    lifecycleCounts.truncated !== record.gamesTruncated ||
    lifecycleCounts.failed !== record.gamesFailed
  ) {
    throw new Error("Experiment run lifecycle counts do not match episode references.");
  }
}

export function lifecycleCountsForReferences(episodes: HarnessExperimentRunEpisodeReferenceV1[]): {
  completed: number;
  truncated: number;
  failed: number;
} {
  return {
    completed: episodes.filter((episode) => episode.status === "completed").length,
    truncated: episodes.filter((episode) => episode.status === "truncated").length,
    failed: episodes.filter((episode) => episode.status === "failed").length
  };
}

export function reviewedFailureReference(index: number, seed: string): HarnessExperimentRunEpisodeReferenceV1 {
  return {
    index,
    seed,
    status: "failed",
    metricCount: 0,
    failureCount: 0,
    error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
  };
}

export function terminalReferenceV3(
  reference: HarnessExperimentRunEpisodeReferenceV1,
  current: HarnessExperimentRunCurrentEpisodeV3,
  disposition: HarnessExperimentRunRecovery["disposition"],
  completedAt: string
): HarnessExperimentRunEpisodeReferenceV3 {
  if (current.phase === "retry-wait") throw new Error("A retry-wait attempt cannot become terminal implicitly.");
  const outcome: HarnessExperimentRunTerminalAttemptV3["outcome"] = disposition === "committed-staged-artifact"
    ? "artifact-committed"
    : disposition === "failed-interrupted-start"
      ? "interrupted-unknown"
      : disposition === "failed-staged-without-artifact"
        ? "staged-artifact-missing"
        : "pre-artifact-failure";
  const terminal: HarnessExperimentRunTerminalAttemptV3 = {
    ordinal: current.ordinal,
    attemptId: current.attemptId,
    outcome,
    startedAt: current.startedAt,
    completedAt: monotonicTimestamp(completedAt, current.updatedAt)
  };
  return {
    ...reference,
    attempts: [...structuredClone(current.priorAttempts), terminal],
    ...(outcome === "artifact-committed" ? { acceptedAttemptId: current.attemptId } : {})
  };
}

export function isAttemptRecord(
  record: HarnessExperimentRunRecord
): record is HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 {
  return record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
    record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3;
}

export function requireAttemptActive(
  record: HarnessExperimentRunRecord
): HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 {
  if (!isAttemptRecord(record)) throw new Error("Experiment episode attempt mutation requires a v2 or v3 run record.");
  if (record.state !== "active") throw new Error("Finalized experiment run cannot mutate an episode attempt.");
  return record;
}

export function requireV3Active(record: HarnessExperimentRunRecord): HarnessExperimentRunRecordV3 {
  if (record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
    throw new Error("Experiment episode retry mutation requires a v3 run record.");
  }
  if (record.state !== "active") throw new Error("Finalized experiment run cannot mutate an episode retry.");
  return record;
}

export function assertCurrentEpisodeV2(
  current: HarnessExperimentRunCurrentEpisodeV2,
  record: HarnessExperimentRunRecordV2
): void {
  assertExactKeys(current, [
    "phase", "attemptId", "index", "seed", "startedAt", "updatedAt", "status", "runId",
    "artifactSha256", "evaluationReportId", "evaluationReportSha256"
  ], "Experiment current episode");
  if (current.phase !== "started" && current.phase !== "staged") throw new Error("Experiment current episode phase is invalid.");
  assertIdentifier(current.attemptId, "currentEpisode.attemptId");
  if (current.index !== record.episodes.length || current.seed !== `${record.experiment.spec.seed}:g${current.index + 1}`) {
    throw new Error("Experiment current episode does not match the next schedule slot.");
  }
  assertTimestamp(current.startedAt, "currentEpisode.startedAt");
  assertTimestamp(current.updatedAt, "currentEpisode.updatedAt");
  if (Date.parse(current.updatedAt) < Date.parse(current.startedAt)) throw new Error("Experiment current episode time moved backwards.");
  if (current.phase === "staged") {
    if (current.status !== "completed" && current.status !== "truncated" && current.status !== "failed") throw new Error("Experiment staged lifecycle is invalid.");
    assertIdentifier(current.runId, "currentEpisode.runId");
    if (!DIRECTORY_KEY_PATTERN.test(current.artifactSha256)) throw new Error("Experiment staged artifact digest is invalid.");
    if ((current.evaluationReportId === undefined) !== (current.evaluationReportSha256 === undefined)) throw new Error("Experiment staged evaluation reference is incomplete.");
  }
}

export function assertCurrentEpisodeV3(
  current: HarnessExperimentRunCurrentEpisodeV3,
  record: HarnessExperimentRunRecordV3
): void {
  assertExactKeys(current, [
    "phase", "attemptId", "ordinal", "index", "seed", "startedAt", "updatedAt", "priorAttempts",
    "code", "scheduledAt", "eligibleAt", "backoffMs", "status", "runId", "artifactSha256",
    "evaluationReportId", "evaluationReportSha256"
  ], "Experiment current episode v3");
  if (current.phase !== "started" && current.phase !== "retry-wait" && current.phase !== "staged") {
    throw new Error("Experiment current episode v3 phase is invalid.");
  }
  assertIdentifier(current.attemptId, "currentEpisode.attemptId");
  if (current.index !== record.episodes.length || current.seed !== `${record.experiment.spec.seed}:g${current.index + 1}`) {
    throw new Error("Experiment current episode does not match the next schedule slot.");
  }
  if (!Number.isSafeInteger(current.ordinal) || current.ordinal < 1 || current.ordinal > record.experiment.spec.retryPolicy.maxAttempts) {
    throw new Error("Experiment current episode attempt ordinal is invalid.");
  }
  assertTimestamp(current.startedAt, "currentEpisode.startedAt");
  assertTimestamp(current.updatedAt, "currentEpisode.updatedAt");
  if (Date.parse(current.updatedAt) < Date.parse(current.startedAt)) throw new Error("Experiment current episode time moved backwards.");
  assertRetriedAttemptsV3(current.priorAttempts, current.ordinal - 1);
  const ids = new Set(current.priorAttempts.map((attempt) => attempt.attemptId));
  if (ids.has(current.attemptId)) throw new Error("Experiment current episode attemptId was reused.");
  if (current.phase === "retry-wait") {
    assertRetryCode(current.code);
    assertTimestamp(current.scheduledAt, "currentEpisode.scheduledAt");
    assertTimestamp(current.eligibleAt, "currentEpisode.eligibleAt");
    if (!Number.isSafeInteger(current.backoffMs) || current.backoffMs < 0) throw new Error("Experiment retry backoffMs is invalid.");
    if (current.scheduledAt !== current.updatedAt || Date.parse(current.scheduledAt) < Date.parse(current.startedAt)) {
      throw new Error("Experiment retry scheduling time is invalid.");
    }
    if (new Date(Date.parse(current.scheduledAt) + current.backoffMs).toISOString() !== current.eligibleAt) {
      throw new Error("Experiment retry eligibleAt does not match its durable backoff.");
    }
    if (current.ordinal >= record.experiment.spec.retryPolicy.maxAttempts) {
      throw new Error("Experiment retry-wait cannot exceed maxAttempts.");
    }
  }
  if (current.phase === "staged") {
    if (current.status !== "completed" && current.status !== "truncated" && current.status !== "failed") {
      throw new Error("Experiment staged lifecycle is invalid.");
    }
    assertIdentifier(current.runId, "currentEpisode.runId");
    if (!DIRECTORY_KEY_PATTERN.test(current.artifactSha256)) throw new Error("Experiment staged artifact digest is invalid.");
    if ((current.evaluationReportId === undefined) !== (current.evaluationReportSha256 === undefined)) {
      throw new Error("Experiment staged evaluation reference is incomplete.");
    }
  }
}

export function assertRetriedAttemptsV3(attempts: HarnessExperimentRunRetriedAttemptV3[], expectedLength: number): void {
  if (!Array.isArray(attempts) || attempts.length !== expectedLength) {
    throw new Error("Experiment v3 retry attempt ledger length is invalid.");
  }
  const ids = new Set<string>();
  for (const [position, attempt] of attempts.entries()) {
    assertExactKeys(attempt, ["ordinal", "attemptId", "outcome", "startedAt", "completedAt", "code"], "Experiment v3 retry attempt");
    if (attempt.ordinal !== position + 1 || attempt.outcome !== "retry-scheduled") {
      throw new Error("Experiment v3 retry attempt ledger is not contiguous.");
    }
    assertIdentifier(attempt.attemptId, "attempts.attemptId");
    if (ids.has(attempt.attemptId)) throw new Error("Experiment v3 attemptId was reused.");
    ids.add(attempt.attemptId);
    assertTimestamp(attempt.startedAt, "attempts.startedAt");
    assertTimestamp(attempt.completedAt, "attempts.completedAt");
    if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) throw new Error("Experiment v3 retry attempt time moved backwards.");
    assertRetryCode(attempt.code);
  }
}

export function assertTerminalEpisodeAttemptsV3(
  episode: HarnessExperimentRunEpisodeReferenceV3,
  record: HarnessExperimentRunRecordV3,
  index: number
): void {
  if (!Array.isArray(episode.attempts) || episode.attempts.length < 1 || episode.attempts.length > record.experiment.spec.retryPolicy.maxAttempts) {
    throw new Error("Experiment v3 terminal attempt ledger length is invalid.");
  }
  const retried = episode.attempts.slice(0, -1) as HarnessExperimentRunRetriedAttemptV3[];
  assertRetriedAttemptsV3(retried, retried.length);
  const terminal = episode.attempts.at(-1)!;
  assertExactKeys(terminal, ["ordinal", "attemptId", "outcome", "startedAt", "completedAt"], "Experiment v3 terminal attempt");
  if (terminal.ordinal !== episode.attempts.length) throw new Error("Experiment v3 terminal attempt ordinal is not contiguous.");
  assertIdentifier(terminal.attemptId, "attempts.terminal.attemptId");
  if (retried.some((attempt) => attempt.attemptId === terminal.attemptId)) throw new Error("Experiment v3 terminal attemptId was reused.");
  if (
    terminal.outcome !== "artifact-committed" && terminal.outcome !== "pre-artifact-failure" &&
    terminal.outcome !== "interrupted-unknown" && terminal.outcome !== "staged-artifact-missing"
  ) throw new Error("Experiment v3 terminal attempt outcome is invalid.");
  assertTimestamp(terminal.startedAt, "attempts.terminal.startedAt");
  assertTimestamp(terminal.completedAt, "attempts.terminal.completedAt");
  if (Date.parse(terminal.completedAt) < Date.parse(terminal.startedAt)) throw new Error("Experiment v3 terminal attempt time moved backwards.");
  if (terminal.outcome === "artifact-committed") {
    if (!episode.runId || episode.acceptedAttemptId !== terminal.attemptId) {
      throw new Error("Experiment v3 accepted attempt does not match its canonical artifact.");
    }
  } else if (episode.acceptedAttemptId !== undefined) {
    throw new Error("Experiment v3 failed terminal attempt cannot be accepted.");
  }
  if (episode.index !== index) throw new Error("Experiment v3 terminal attempt ledger index is invalid.");
}

export function assertRetryCode(code: HarnessExperimentEpisodeRetryCode): void {
  // The owning domain adapter/retry-policy version defines the closed
  // vocabulary. The generic store accepts only a bounded machine code shape,
  // never exception/provider text.
  if (typeof code !== "string" || code.length > 96 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(code)) {
    throw new Error("Experiment retry code is not a safe reviewed classifier code.");
  }
}

export function assertV2Transition(previous: HarnessExperimentRunRecordV2, current: HarnessExperimentRunRecordV2): void {
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  const previousStage = previous.currentEpisode;
  const currentStage = current.currentEpisode;
  if (!previousStage && currentStage?.phase === "started" && current.episodes.length === previous.episodes.length) return;
  if (previousStage?.phase === "started" && currentStage?.phase === "staged" && current.episodes.length === previous.episodes.length) {
    if (
      previousStage.attemptId !== currentStage.attemptId || previousStage.index !== currentStage.index ||
      previousStage.seed !== currentStage.seed || previousStage.startedAt !== currentStage.startedAt
    ) throw new Error("Experiment staged transition changed durable attempt identity.");
    return;
  }
  if (previousStage && !currentStage && current.episodes.length === previous.episodes.length + 1) return;
  throw new Error("Experiment v2 revision transition is invalid.");
}

export function assertV3Transition(previous: HarnessExperimentRunRecordV3, current: HarnessExperimentRunRecordV3): void {
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  const before = previous.currentEpisode;
  const after = current.currentEpisode;
  if (!before && after?.phase === "started" && after.ordinal === 1 && current.episodes.length === previous.episodes.length) return;
  if (before?.phase === "started" && after?.phase === "retry-wait" && current.episodes.length === previous.episodes.length) {
    assertV3CurrentIdentityStable(before, after);
    if (hashStableJsonValue(before.priorAttempts) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 retry scheduling changed prior attempt history.");
    }
    return;
  }
  if (before?.phase === "retry-wait" && after?.phase === "started" && current.episodes.length === previous.episodes.length) {
    if (before.index !== after.index || before.seed !== after.seed || after.ordinal !== before.ordinal + 1) {
      throw new Error("Experiment v3 retry start changed schedule identity or attempt ordinal.");
    }
    if (after.attemptId === before.attemptId) throw new Error("Experiment v3 retry start reused attemptId.");
    const expectedPrior: HarnessExperimentRunRetriedAttemptV3[] = [...before.priorAttempts, {
      ordinal: before.ordinal,
      attemptId: before.attemptId,
      outcome: "retry-scheduled",
      startedAt: before.startedAt,
      completedAt: before.scheduledAt,
      code: before.code
    }];
    if (hashStableJsonValue(expectedPrior) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 retry start did not append the durable prior attempt.");
    }
    return;
  }
  if (before?.phase === "started" && after?.phase === "staged" && current.episodes.length === previous.episodes.length) {
    assertV3CurrentIdentityStable(before, after);
    if (hashStableJsonValue(before.priorAttempts) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 staging changed prior attempt history.");
    }
    return;
  }
  if (before && !after && current.episodes.length === previous.episodes.length + 1) {
    if (before.phase === "retry-wait") throw new Error("Experiment v3 retry-wait cannot become terminal implicitly.");
    const terminal = current.episodes.at(-1)!;
    const expectedAttempts = [...before.priorAttempts, terminal.attempts.at(-1)!];
    if (hashStableJsonValue(expectedAttempts) !== hashStableJsonValue(terminal.attempts)) {
      throw new Error("Experiment v3 terminal commit changed attempt history.");
    }
    return;
  }
  throw new Error("Experiment v3 revision transition is invalid.");
}

export function assertV3CurrentIdentityStable(
  previous: HarnessExperimentRunStartedEpisodeV3,
  current: HarnessExperimentRunRetryWaitEpisodeV3 | HarnessExperimentRunStagedEpisodeV3
): void {
  if (
    previous.attemptId !== current.attemptId || previous.ordinal !== current.ordinal ||
    previous.index !== current.index || previous.seed !== current.seed || previous.startedAt !== current.startedAt
  ) throw new Error("Experiment v3 transition changed durable attempt identity.");
}

export function assertEpisodeReferencePrefix(
  prefix: HarnessExperimentRunEpisodeReferenceV1[],
  episodes: HarnessExperimentRunEpisodeReferenceV1[]
): void {
  if (prefix.length > episodes.length) throw new Error("Experiment run revision removed durable episode progress.");
  for (const [index, episode] of prefix.entries()) {
    if (hashStableJsonValue(episode) !== hashStableJsonValue(episodes[index])) {
      throw new Error("Experiment run revision changed durable episode history.");
    }
  }
}

export function assertEpisodeReferencesEqual(
  expected: HarnessExperimentRunEpisodeReferenceV1[],
  actual: HarnessExperimentRunEpisodeReferenceV1[]
): void {
  if (expected.length !== actual.length) {
    throw new Error("Experiment run finalization does not match durable episode progress.");
  }
  for (const [index, episode] of expected.entries()) {
    if (hashStableJsonValue(episode) !== hashStableJsonValue(actual[index])) {
      throw new Error("Experiment run finalization changed durable episode history.");
    }
  }
}

export function assertFinalRunSetMatchesRecord<TArtifact extends GenericEpisodeEnvelope>(
  runSet: GenericTournamentRunSetArtifact<TArtifact>,
  record: HarnessExperimentRunRecord
): void {
  const expectedUnstarted = runSet.gamesUnstarted ?? runSet.gamesRequested - runSet.episodes.length;
  if (
    runSet.createdAt !== record.createdAt ||
    runSet.gamesRequested !== record.gamesRequested ||
    runSet.gamesCompleted !== record.gamesCompleted ||
    runSet.gamesTruncated !== record.gamesTruncated ||
    runSet.gamesFailed !== record.gamesFailed ||
    expectedUnstarted !== record.gamesUnstarted
  ) {
    throw new Error("Experiment run finalization lifecycle does not match durable progress.");
  }
}

export function monotonicTimestamp(candidate: string, previous: string): string {
  assertTimestamp(candidate, "updatedAt");
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}

export function assertActiveProgressTransition(
  previous: HarnessExperimentRunRecord,
  current: HarnessExperimentRunRecord
): void {
  if (previous.schemaVersion !== current.schemaVersion) throw new Error("Experiment run revision changed record schema version.");
  if (previous.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 && current.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2) {
    assertV2Transition(previous, current);
    return;
  }
  if (previous.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && current.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
    assertV3Transition(previous, current);
    return;
  }
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  if (current.episodes.length !== previous.episodes.length + 1) {
    throw new Error("Active experiment run revision must append exactly one terminal episode.");
  }
}

export function assertManifest(
  manifest: HarnessExperimentRunManifest,
  record: HarnessExperimentRunRecord,
  directoryKey: string,
  revision: number,
  recordText: string,
  revisionDirectory: string
): void {
  assertExactKeys(manifest, [
    "schemaVersion", "recordSchemaVersion", "kind", "runSetId", "directoryKey", "revision", "state", "recordSha256", "files"
  ], "Experiment run manifest");
  assertExactKeys(manifest.files, ["record", "manifest"], "Experiment run manifest files");
  if (
    (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION &&
      manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 &&
      manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3) ||
    manifest.kind !== "experiment-run-manifest"
  ) {
    throw new Error("Experiment run manifest version or kind is invalid.");
  }
  if (
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 ||
        manifest.recordSchemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2)) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3 ||
        manifest.recordSchemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3)) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION || "recordSchemaVersion" in manifest))
  ) throw new Error("Experiment run manifest does not match the record schema version.");
  if (
    manifest.runSetId !== record.runSetId ||
    manifest.directoryKey !== directoryKey ||
    manifest.revision !== revision ||
    manifest.state !== record.state ||
    manifest.recordSha256 !== sha256(recordText) ||
    manifest.files.record !== RECORD_FILE ||
    manifest.files.manifest !== MANIFEST_FILE
  ) throw new Error("Experiment run manifest does not match its canonical record.");
  if (
    revisionDirectory !== revisionSlotDirectoryName(revision) &&
    revisionDirectory !== revisionDirectoryName(revision, manifest.recordSha256)
  ) {
    throw new Error("Experiment run revision directory does not match its canonical slot or content hash.");
  }
}

export function entryFromRecord(record: HarnessExperimentRunRecord, directoryKey: string, revision: number): HarnessExperimentRunStoreEntry {
  return {
    runSetId: record.runSetId,
    specId: record.experiment.spec.id,
    specHash: record.experiment.specHash,
    domainId: record.experiment.spec.domainId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    directoryKey,
    revision,
    state: record.state,
    gamesRequested: record.gamesRequested,
    gamesCompleted: record.gamesCompleted,
    gamesTruncated: record.gamesTruncated,
    gamesFailed: record.gamesFailed,
    ...(isAttemptRecord(record) ? { gamesInFlight: record.gamesInFlight } : {}),
    gamesUnstarted: record.gamesUnstarted
  };
}

export function revisionDirectoryName(revision: number, recordSha256: string): string {
  return `${String(revision).padStart(12, "0")}-${recordSha256.slice(0, 16)}`;
}

export function revisionSlotDirectoryName(revision: number): string {
  return String(revision).padStart(12, "0");
}

export function directoryKeyForRunSetId(runSetId: string): string {
  return createHash("sha256").update(runSetId).digest("hex");
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
}

export function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

export function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

export function compareEntries(a: HarnessExperimentRunStoreEntry, b: HarnessExperimentRunStoreEntry): number {
  return a.createdAt.localeCompare(b.createdAt) || a.runSetId.localeCompare(b.runSetId);
}
