import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1
} from "../experimentSpec";
import type {
  GenericTournamentRunSetArtifact,
  GenericTournamentRunSetEpisode
} from "../genericTournamentArtifacts";
import { validateGenericTournamentRunSetArtifact } from "../genericTournamentArtifacts";
import { hashStableJsonValue } from "../hash";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "../tournamentRunner";
import {
  DIRECTORY_KEY_PATTERN,
  HARNESS_EXPERIMENT_RUN_INDEX_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  INDEX_FILE,
  LOCKS_DIRECTORY,
  MANIFEST_FILE,
  RECORD_FILE,
  REVISIONS_DIRECTORY,
  REVISION_DIRECTORY_PATTERN,
  RUNS_DIRECTORY,
  RUN_LEASE_ACQUIRED_MARKER,
  type GenericEpisodeEnvelope,
  type GenericExperimentEpisodeAuthority,
  type HarnessExperimentEpisodeRetryCode,
  type HarnessExperimentRunCurrentEpisodeV3,
  type HarnessExperimentRunEpisodeReferenceV1,
  type HarnessExperimentRunEpisodeReferenceV3,
  type HarnessExperimentRunManifest,
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunRecordV1,
  type HarnessExperimentRunRecordV2,
  type HarnessExperimentRunRecordV3,
  type HarnessExperimentRunRecovery,
  type HarnessExperimentRunResume,
  type HarnessExperimentRunStartedEpisodeV3,
  type HarnessExperimentRunStoreEntry,
  type HarnessExperimentRunStoreIndexV1,
  type HarnessExperimentRunStoreOptions
} from "./types";
import {
  assertActiveProgressTransition,
  assertEpisodeReferencesEqual,
  assertFinalRunSetMatchesRecord,
  assertIdentifier,
  assertManifest,
  assertRetryCode,
  assertRunRecord,
  assertTimestamp,
  compareEntries,
  directoryKeyForRunSetId,
  entryFromRecord,
  jsonDocument,
  lifecycleCountsForReferences,
  monotonicTimestamp,
  requireAttemptActive,
  requireV3Active,
  reviewedFailureReference,
  revisionSlotDirectoryName,
  sha256,
  terminalReferenceV3
} from "./validation";
import {
  assertDirectory,
  assertDirectoryInside,
  assertPathMissing,
  assertWritableFileTarget,
  isAlreadyExists,
  isMissing,
  readSafeFile,
  releaseRunLease,
  waitForRunLease
} from "./fsSupport";

class ExperimentRevisionCasConflict extends Error {
  constructor(readonly revision: number) {
    super(`Experiment run revision ${revision} lost its canonical CAS slot.`);
    this.name = "ExperimentRevisionCasConflict";
  }
}

/**
 * Restart-safe control-plane membership authority. Episode content remains in
 * HarnessEpisodeArtifactStore; this store persists only experiment provenance,
 * ordered lifecycle membership, reviewed failure state, and content hashes.
 * Recovery never constructs an actor, policy, reasoner, or provider client.
 */
export class HarnessExperimentRunStore<TArtifact extends GenericEpisodeEnvelope> {
  private readonly root: string;
  private readonly runsDirectory: string;
  private readonly locksDirectory: string;
  private readonly episodeStore: GenericExperimentEpisodeAuthority<TArtifact>;
  private readonly now: () => string;
  private readonly entries = new Map<string, HarnessExperimentRunStoreEntry>();
  private readonly mutating = new Set<string>();

  private constructor(options: HarnessExperimentRunStoreOptions<TArtifact>) {
    if (!options.baseDirectory.trim()) throw new Error("Experiment run store baseDirectory is required.");
    if (!options.episodeStore || typeof options.episodeStore.get !== "function") {
      throw new Error("Experiment run store requires a canonical episode store.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.runsDirectory = path.join(this.root, RUNS_DIRECTORY);
    this.locksDirectory = path.join(this.root, LOCKS_DIRECTORY);
    this.episodeStore = options.episodeStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open<TArtifact extends GenericEpisodeEnvelope>(
    options: HarnessExperimentRunStoreOptions<TArtifact>
  ): Promise<HarnessExperimentRunStore<TArtifact>> {
    const store = new HarnessExperimentRunStore(options);
    await store.initialize();
    return store;
  }

  /**
   * Hold a kernel-released, run-scoped lease for the complete orchestration
   * lifecycle. A second live process fails closed instead of recovering work
   * that is merely slow. Linux flock releases the lease automatically after a
   * process crash; revision CAS remains the lower-level fencing boundary.
   */
  async withRunLease<TResult>(runSetId: string, operation: () => Promise<TResult>): Promise<TResult> {
    assertIdentifier(runSetId, "runSetId");
    if (typeof operation !== "function") throw new Error("Experiment run lease operation is required.");
    const lease = await this.acquireRunLease(runSetId);
    try {
      return await operation();
    } finally {
      await releaseRunLease(lease);
    }
  }

  async begin(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
  }): Promise<HarnessExperimentRunStoreEntry> {
    assertIdentifier(input.runSetId, "runSetId");
    const experiment = structuredClone(input.experiment);
    const provenanceErrors = validateGenericExperimentProvenance(experiment);
    if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
    if (this.entries.has(input.runSetId)) throw new Error("Experiment run already exists for this runSetId.");

    const createdAt = input.createdAt ?? this.now();
    const record: HarnessExperimentRunRecordV1 = {
      schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
      kind: "experiment-run-record",
      state: "active",
      runSetId: input.runSetId,
      createdAt,
      updatedAt: createdAt,
      experiment,
      gamesRequested: experiment.spec.episodeCount,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesUnstarted: experiment.spec.episodeCount,
      episodes: []
    };
    assertRunRecord(record);

    const directoryKey = directoryKeyForRunSetId(record.runSetId);
    const finalDirectory = path.join(this.runsDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Experiment run already exists for this runSetId.");
    const temporaryDirectory = path.join(this.runsDirectory, `.tmp-${randomUUID()}`);
    const revisionsDirectory = path.join(temporaryDirectory, REVISIONS_DIRECTORY);
    await mkdir(revisionsDirectory, { recursive: true });
    try {
      await this.writeRevision(revisionsDirectory, directoryKey, 1, record);
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const entry = entryFromRecord(record, directoryKey, 1);
    this.entries.set(entry.runSetId, entry);
    await this.writeIndex();
    return structuredClone(entry);
  }

  /**
   * Production experiment entrypoint. New runs use the staged v2 lifecycle;
   * exact v2/finalized retries return durable authority without creating a
   * revision. Active v1 runs are intentionally ambiguous and never resume.
   */
  async beginOrResume(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
  }): Promise<HarnessExperimentRunResume> {
    assertIdentifier(input.runSetId, "runSetId");
    const experiment = structuredClone(input.experiment);
    const provenanceErrors = validateGenericExperimentProvenance(experiment);
    if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
    const loaded = await this.loadKnownRun(input.runSetId);
    if (loaded) {
      if (hashStableJsonValue(loaded.record.experiment) !== hashStableJsonValue(experiment)) {
        throw new Error("Experiment run resume provenance conflicts with durable authority.");
      }
      if (input.createdAt !== undefined && input.createdAt !== loaded.record.createdAt) {
        throw new Error("Experiment run resume createdAt conflicts with durable authority.");
      }
      if (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION && loaded.record.state === "active") {
        throw new Error("Active v1 experiment run is ambiguous and cannot be resumed automatically.");
      }
      return {
        disposition: loaded.record.state === "finalized" ? "finalized" : "active",
        record: structuredClone(loaded.record),
        revision: loaded.entry.revision
      };
    }

    const createdAt = input.createdAt ?? this.now();
    const record: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = {
      schemaVersion: experiment.spec.retryPolicy.maxAttempts > 1
        ? HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        : HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
      kind: "experiment-run-record",
      state: "active",
      runSetId: input.runSetId,
      createdAt,
      updatedAt: createdAt,
      experiment,
      gamesRequested: experiment.spec.episodeCount,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesInFlight: 0,
      gamesUnstarted: experiment.spec.episodeCount,
      episodes: []
    };
    assertRunRecord(record);
    const directoryKey = directoryKeyForRunSetId(record.runSetId);
    const finalDirectory = path.join(this.runsDirectory, directoryKey);
    const temporaryDirectory = path.join(this.runsDirectory, `.tmp-${randomUUID()}`);
    const revisionsDirectory = path.join(temporaryDirectory, REVISIONS_DIRECTORY);
    await mkdir(revisionsDirectory, { recursive: true });
    try {
      await this.writeRevision(revisionsDirectory, directoryKey, 1, record);
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      const winner = await this.loadKnownRun(input.runSetId);
      if (!winner) throw error;
      if (hashStableJsonValue(winner.record.experiment) !== hashStableJsonValue(experiment)) {
        throw new Error("Experiment run resume provenance conflicts with concurrently published authority.");
      }
      if (input.createdAt !== undefined && input.createdAt !== winner.record.createdAt) {
        throw new Error("Experiment run resume createdAt conflicts with concurrently published authority.");
      }
      return {
        disposition: winner.record.state === "finalized" ? "finalized" : "active",
        record: structuredClone(winner.record),
        revision: winner.entry.revision
      };
    }
    const entry = entryFromRecord(record, directoryKey, 1);
    this.entries.set(entry.runSetId, entry);
    await this.writeIndex();
    return { disposition: "created", record: structuredClone(record), revision: 1 };
  }

  async startEpisode(input: {
    runSetId: string;
    index: number;
    seed: string;
    startedAt?: string;
  }): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireAttemptActive(loaded.record);
      const expectedIndex = record.episodes.length;
      const expectedSeed = `${record.experiment.spec.seed}:g${expectedIndex + 1}`;
      if (input.index !== expectedIndex || input.seed !== expectedSeed) {
        throw new Error("Experiment episode start does not match the next durable schedule slot.");
      }
      if (record.currentEpisode) {
        if (record.currentEpisode.index !== input.index || record.currentEpisode.seed !== input.seed) {
          throw new Error("Experiment run already has a different episode in flight.");
        }
        if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 || record.currentEpisode.phase !== "retry-wait") {
          if (
            record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 &&
            input.startedAt !== undefined && input.startedAt !== record.currentEpisode.startedAt
          ) throw new Error("Experiment episode start retry conflicts with durable attempt time.");
          return { record, write: false };
        }
        const current = record.currentEpisode;
        const startedAt = input.startedAt ?? this.now();
        assertTimestamp(startedAt, "startedAt");
        if (Date.parse(startedAt) < Date.parse(current.eligibleAt)) {
          throw new Error("Experiment episode retry is not eligible to start yet.");
        }
        const next: HarnessExperimentRunRecordV3 = {
          ...structuredClone(record),
          updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
          currentEpisode: {
            phase: "started",
            index: current.index,
            seed: current.seed,
            ordinal: current.ordinal + 1,
            attemptId: randomUUID(),
            startedAt,
            updatedAt: startedAt,
            priorAttempts: [...current.priorAttempts, {
              ordinal: current.ordinal,
              attemptId: current.attemptId,
              outcome: "retry-scheduled",
              startedAt: current.startedAt,
              completedAt: current.scheduledAt,
              code: current.code
            }]
          }
        };
        return { record: next, write: true };
      }
      if (record.gamesUnstarted <= 0) throw new Error("Experiment run has no unstarted episode slot.");
      const startedAt = input.startedAt ?? this.now();
      assertTimestamp(startedAt, "startedAt");
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
            gamesInFlight: 1,
            gamesUnstarted: record.gamesUnstarted - 1,
            currentEpisode: {
              phase: "started",
              attemptId: randomUUID(),
              ordinal: 1,
              index: input.index,
              seed: input.seed,
              startedAt,
              updatedAt: startedAt,
              priorAttempts: []
            }
          }
        : {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
        gamesInFlight: 1,
        gamesUnstarted: record.gamesUnstarted - 1,
        currentEpisode: {
          phase: "started",
          attemptId: randomUUID(),
          index: input.index,
          seed: input.seed,
          startedAt,
          updatedAt: startedAt
        }
          };
      return { record: next, write: true };
    });
  }

  async scheduleEpisodeRetry(input: {
    runSetId: string;
    code: HarnessExperimentEpisodeRetryCode;
    scheduledAt?: string;
    backoffMs: number;
  }): Promise<HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireV3Active(loaded.record);
      const current = record.currentEpisode;
      if (!current) throw new Error("Experiment retry requires a durably started attempt.");
      if (current.phase === "retry-wait") {
        if (
          current.code !== input.code || current.backoffMs !== input.backoffMs ||
          (input.scheduledAt !== undefined && input.scheduledAt !== current.scheduledAt)
        ) {
          throw new Error("Experiment retry scheduling conflicts with durable authority.");
        }
        return { record, write: false };
      }
      if (current.phase !== "started") throw new Error("Only a started episode attempt may schedule a retry.");
      assertRetryCode(input.code);
      if (!Number.isSafeInteger(input.backoffMs) || input.backoffMs < 0) {
        throw new Error("Experiment retry backoffMs must be a non-negative safe integer.");
      }
      if (current.ordinal >= record.experiment.spec.retryPolicy.maxAttempts) {
        throw new Error("Experiment episode retry would exceed maxAttempts.");
      }
      const scheduledAt = input.scheduledAt ?? this.now();
      assertTimestamp(scheduledAt, "scheduledAt");
      const eligibleAt = new Date(Date.parse(scheduledAt) + input.backoffMs).toISOString();
      const next: HarnessExperimentRunRecordV3 = {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(scheduledAt, record.updatedAt),
        currentEpisode: {
          ...structuredClone(current),
          phase: "retry-wait",
          updatedAt: scheduledAt,
          code: input.code,
          scheduledAt,
          eligibleAt,
          backoffMs: input.backoffMs
        }
      };
      return { record: next, write: true };
    }) as Promise<HarnessExperimentRunRecordV3>;
  }

  async stageEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact> & { runId: string; artifact: TArtifact };
    stagedAt?: string;
  }): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireAttemptActive(loaded.record);
      const current = record.currentEpisode;
      if (!current) throw new Error("Experiment episode must be durably started before staging publication.");
      const episode = input.episode;
      if (episode.index !== current.index || episode.seed !== current.seed || episode.runId !== episode.artifact.runId) {
        throw new Error("Experiment staged episode identity does not match the durable attempt.");
      }
      if (!episode.artifact.experiment || hashStableJsonValue(episode.artifact.experiment) !== hashStableJsonValue(record.experiment)) {
        throw new Error("Experiment staged episode provenance does not match durable authority.");
      }
      if (episode.artifact.status !== episode.status) {
        throw new Error("Experiment staged episode lifecycle does not match its artifact.");
      }
      const candidate = {
        status: episode.status,
        runId: episode.runId,
        artifactSha256: hashStableJsonValue(episode.artifact),
        ...(episode.evaluationReport ? {
          evaluationReportId: episode.evaluationReport.id,
          evaluationReportSha256: hashStableJsonValue(episode.evaluationReport)
        } : {})
      };
      if (current.phase === "staged") {
        const existing = {
          status: current.status,
          runId: current.runId,
          artifactSha256: current.artifactSha256,
          ...(current.evaluationReportId ? {
            evaluationReportId: current.evaluationReportId,
            evaluationReportSha256: current.evaluationReportSha256
          } : {})
        };
        if (hashStableJsonValue(existing) !== hashStableJsonValue(candidate)) {
          throw new Error("Experiment staged episode retry conflicts with durable candidate identity.");
        }
        return { record, write: false };
      }
      if (current.phase !== "started") {
        throw new Error("Experiment episode must be in started phase before staging publication.");
      }
      const stagedAt = input.stagedAt ?? this.now();
      assertTimestamp(stagedAt, "stagedAt");
      const commonCurrent = {
        phase: "staged" as const,
        attemptId: current.attemptId,
        index: current.index,
        seed: current.seed,
        startedAt: current.startedAt,
        updatedAt: stagedAt,
        ...candidate
      };
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(stagedAt, record.updatedAt),
            currentEpisode: {
              ...commonCurrent,
              ordinal: (current as HarnessExperimentRunStartedEpisodeV3).ordinal,
              priorAttempts: structuredClone((current as HarnessExperimentRunStartedEpisodeV3).priorAttempts)
            }
          }
        : {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(stagedAt, record.updatedAt),
            currentEpisode: commonCurrent
          };
      return { record: next, write: true };
    });
  }

  async recoverCurrentEpisode(runSetId: string): Promise<HarnessExperimentRunRecovery> {
    let disposition: HarnessExperimentRunRecovery["disposition"] = "none";
    const record = await this.mutateAttemptRecord(runSetId, async (loaded) => {
      const currentRecord = requireAttemptActive(loaded.record);
      const current = currentRecord.currentEpisode;
      if (!current) return { record: currentRecord, write: false };
      if (currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && current.phase === "retry-wait") {
        disposition = "retry-wait";
        return { record: currentRecord, write: false };
      }
      let reference: HarnessExperimentRunEpisodeReferenceV1;
      if (current.phase === "staged") {
        const artifact = await this.episodeStore.get(current.runId);
        if (artifact) {
          const evaluationReport = await this.episodeStore.getEvaluationReport(current.runId);
          reference = await this.referenceForEpisode({
            index: current.index,
            seed: current.seed,
            status: current.status,
            runId: current.runId,
            artifact,
            ...(evaluationReport ? { evaluationReport } : {})
          }, currentRecord, new Set(currentRecord.episodes.flatMap((episode) => episode.runId ? [episode.runId] : [])));
          if (
            reference.artifactSha256 !== current.artifactSha256 ||
            reference.evaluationReportId !== current.evaluationReportId ||
            reference.evaluationReportSha256 !== current.evaluationReportSha256
          ) throw new Error("Canonical staged episode does not match durable publication identity.");
          disposition = "committed-staged-artifact";
        } else {
          reference = reviewedFailureReference(current.index, current.seed);
          disposition = "failed-staged-without-artifact";
        }
      } else {
        reference = reviewedFailureReference(current.index, current.seed);
        disposition = "failed-interrupted-start";
      }
      const durableReference = currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? terminalReferenceV3(reference, current as HarnessExperimentRunCurrentEpisodeV3, disposition, this.now())
        : reference;
      const episodes = [...currentRecord.episodes, durableReference];
      const counts = lifecycleCountsForReferences(episodes);
      const common = {
        updatedAt: monotonicTimestamp(this.now(), currentRecord.updatedAt),
        gamesCompleted: counts.completed,
        gamesTruncated: counts.truncated,
        gamesFailed: counts.failed,
        gamesInFlight: 0 as const
      };
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? { ...structuredClone(currentRecord), ...common, episodes: episodes as HarnessExperimentRunEpisodeReferenceV3[] }
        : { ...structuredClone(currentRecord), ...common, episodes: episodes as HarnessExperimentRunEpisodeReferenceV1[] };
      delete next.currentEpisode;
      return { record: next, write: true };
    });
    return { disposition, record };
  }

  /**
   * Append one terminal episode membership revision after its canonical
   * artifact/sidecars have been published (or after a reviewed pre-artifact
   * failure). The ordered prefix survives process restart independently of
   * final run-set materialization.
   */
  async recordEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact>;
  }): Promise<HarnessExperimentRunStoreEntry> {
    if (this.mutating.has(input.runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(input.runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
      const loaded = await this.loadKnownRun(input.runSetId);
      if (!loaded) throw new Error("Experiment run must begin before an episode can be recorded.");
      const expectedIndex = loaded.record.episodes.length;
      const existingRunIds = new Set(
        loaded.record.episodes.flatMap((episode, index) =>
          index === input.episode.index || !episode.runId ? [] : [episode.runId]
        )
      );
      const baseReference = await this.referenceForEpisode(input.episode, loaded.record, existingRunIds);
      const reference = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? loaded.record.currentEpisode
          ? terminalReferenceV3(
              baseReference,
              loaded.record.currentEpisode as HarnessExperimentRunCurrentEpisodeV3,
              input.episode.artifact ? "committed-staged-artifact" : "none",
              this.now()
            )
          : loaded.record.episodes[input.episode.index]
            ? {
                ...baseReference,
                attempts: structuredClone(loaded.record.episodes[input.episode.index]!.attempts),
                ...(loaded.record.episodes[input.episode.index]!.acceptedAttemptId
                  ? { acceptedAttemptId: loaded.record.episodes[input.episode.index]!.acceptedAttemptId }
                  : {})
              }
            : baseReference
        : baseReference;
      if (input.episode.index < expectedIndex) {
        const existing = loaded.record.episodes[input.episode.index];
        if (!existing || hashStableJsonValue(existing) !== hashStableJsonValue(reference)) {
          throw new Error("Experiment run episode retry does not match durable progress.");
        }
        return structuredClone(loaded.entry);
      }
      if (loaded.record.state !== "active") throw new Error("Finalized experiment run cannot record another episode.");
      if (input.episode.index > expectedIndex) throw new Error("Experiment run episode progress must be contiguous and ordered.");
      const episodes = [...loaded.record.episodes, reference];
      const counts = lifecycleCountsForReferences(episodes);
      let record: HarnessExperimentRunRecord;
      if (
        loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
        loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
      ) {
        const current = loaded.record.currentEpisode;
        if (!current || current.index !== input.episode.index || current.seed !== input.episode.seed) {
          throw new Error("Experiment terminal episode does not match the durable in-flight attempt.");
        }
        if (input.episode.artifact) {
          if (
            current.phase !== "staged" ||
            current.runId !== reference.runId ||
            current.status !== reference.status ||
            current.artifactSha256 !== reference.artifactSha256 ||
            current.evaluationReportId !== reference.evaluationReportId ||
            current.evaluationReportSha256 !== reference.evaluationReportSha256
          ) {
            throw new Error("Experiment terminal episode does not match the staged candidate.");
          }
        } else if (current.phase !== "started") {
          throw new Error("Only a started episode may commit a pre-artifact failure.");
        }
        if (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
          const next: HarnessExperimentRunRecordV3 = {
            ...structuredClone(loaded.record),
            updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
            gamesCompleted: counts.completed,
            gamesTruncated: counts.truncated,
            gamesFailed: counts.failed,
            gamesInFlight: 0,
            episodes: episodes as HarnessExperimentRunEpisodeReferenceV3[]
          };
          delete next.currentEpisode;
          record = next;
        } else {
          const next: HarnessExperimentRunRecordV2 = {
            ...structuredClone(loaded.record),
            updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
            gamesCompleted: counts.completed,
            gamesTruncated: counts.truncated,
            gamesFailed: counts.failed,
            gamesInFlight: 0,
            episodes: episodes as HarnessExperimentRunEpisodeReferenceV1[]
          };
          delete next.currentEpisode;
          record = next;
        }
      } else {
        record = {
          ...structuredClone(loaded.record),
          updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
          gamesCompleted: counts.completed,
          gamesTruncated: counts.truncated,
          gamesFailed: counts.failed,
          gamesUnstarted: loaded.record.gamesRequested - episodes.length,
          episodes
        };
      }
      assertRunRecord(record);
      const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
      await assertDirectoryInside(
        path.join(this.runsDirectory, loaded.entry.directoryKey),
        revisionsDirectory,
        "Experiment run revisions directory is not safe."
      );
      try {
        await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, record);
      } catch (error) {
        if (error instanceof ExperimentRevisionCasConflict) continue;
        throw error;
      }
      const entry = entryFromRecord(record, loaded.entry.directoryKey, loaded.entry.revision + 1);
      this.entries.set(entry.runSetId, entry);
      await this.writeIndex();
      return structuredClone(entry);
      }
      throw new Error("Experiment run episode commit exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(input.runSetId);
    }
  }

  async finalize<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>
  ): Promise<HarnessExperimentRunStoreEntry> {
    if (this.mutating.has(runSet.runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(runSet.runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
      const loaded = await this.loadKnownRun(runSet.runSetId);
      if (!loaded) throw new Error("Experiment run must begin before it can be finalized.");
      const projectedRefs = await this.referencesForRunSet(runSet, loaded.record);
      const durableV3 = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 ? loaded.record : undefined;
      const refs: HarnessExperimentRunEpisodeReferenceV1[] = durableV3
        ? projectedRefs.map((reference, index) => ({
            ...reference,
            attempts: structuredClone(durableV3.episodes[index]!.attempts),
            ...(durableV3.episodes[index]!.acceptedAttemptId
              ? { acceptedAttemptId: durableV3.episodes[index]!.acceptedAttemptId }
              : {})
          }))
        : projectedRefs;
      assertEpisodeReferencesEqual(loaded.record.episodes, refs);
      assertFinalRunSetMatchesRecord(runSet, loaded.record);
      if (loaded.record.state === "finalized") return structuredClone(loaded.entry);
      if (
        (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
          loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) &&
        loaded.record.currentEpisode
      ) {
        throw new Error("Experiment run cannot finalize while an episode is in flight.");
      }
      const commonFinal = {
        kind: "experiment-run-record" as const,
        state: "finalized" as const,
        runSetId: loaded.record.runSetId,
        createdAt: loaded.record.createdAt,
        updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
        experiment: structuredClone(loaded.record.experiment),
        gamesRequested: runSet.gamesRequested,
        gamesCompleted: runSet.gamesCompleted,
        gamesTruncated: runSet.gamesTruncated,
        gamesFailed: runSet.gamesFailed,
        gamesUnstarted: runSet.gamesUnstarted ?? runSet.gamesRequested - runSet.episodes.length,
        episodes: refs
      };
      const record: HarnessExperimentRunRecord = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
            gamesInFlight: 0,
            ...commonFinal,
            episodes: structuredClone(loaded.record.episodes)
          }
        : loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2
          ? { schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2, gamesInFlight: 0, ...commonFinal }
          : { schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION, ...commonFinal };
      assertRunRecord(record);
      const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
      await assertDirectoryInside(
        path.join(this.runsDirectory, loaded.entry.directoryKey),
        revisionsDirectory,
        "Experiment run revisions directory is not safe."
      );
      try {
        await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, record);
      } catch (error) {
        if (error instanceof ExperimentRevisionCasConflict) continue;
        throw error;
      }
      const entry = entryFromRecord(record, loaded.entry.directoryKey, loaded.entry.revision + 1);
      this.entries.set(entry.runSetId, entry);
      await this.writeIndex();
      return structuredClone(entry);
      }
      throw new Error("Experiment run finalization exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(runSet.runSetId);
    }
  }

  async get(runSetId: string): Promise<HarnessExperimentRunRecord | undefined> {
    const loaded = await this.loadKnownRun(runSetId);
    return loaded ? structuredClone(loaded.record) : undefined;
  }

  async list(): Promise<HarnessExperimentRunStoreEntry[]> {
    await this.refreshEntriesFromCanonicalRuns();
    const verified: HarnessExperimentRunStoreEntry[] = [];
    for (const entry of [...this.entries.values()].sort(compareEntries)) {
      const loaded = await this.loadDirectory(entry.directoryKey, entry.runSetId);
      if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
      verified.push(structuredClone(loaded.entry));
    }
    return verified;
  }

  private async mutateAttemptRecord(
    runSetId: string,
    mutation: (loaded: { record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry }) =>
      Promise<{ record: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3; write: boolean }>
  ): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    if (this.mutating.has(runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const loaded = await this.loadKnownRun(runSetId);
        if (!loaded) throw new Error("Experiment run must begin before it can mutate an episode attempt.");
        const result = await mutation(loaded);
        assertRunRecord(result.record);
        if (!result.write) return structuredClone(result.record);
        const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
        await assertDirectoryInside(
          path.join(this.runsDirectory, loaded.entry.directoryKey),
          revisionsDirectory,
          "Experiment run revisions directory is not safe."
        );
        try {
          await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, result.record);
        } catch (error) {
          if (error instanceof ExperimentRevisionCasConflict) continue;
          throw error;
        }
        const entry = entryFromRecord(result.record, loaded.entry.directoryKey, loaded.entry.revision + 1);
        this.entries.set(entry.runSetId, entry);
        await this.writeIndex();
        return structuredClone(result.record);
      }
      throw new Error("Experiment run mutation exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(runSetId);
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertDirectory(this.root, "Experiment run store root is not a safe directory.");
    await mkdir(this.runsDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.runsDirectory, "Experiment runs directory is not safe.");
    await mkdir(this.locksDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.locksDirectory, "Experiment run locks directory is not safe.");
    await assertWritableFileTarget(path.join(this.root, INDEX_FILE), "Experiment run index is not a safe regular file.");

    await this.refreshEntriesFromCanonicalRuns();
    await this.writeIndex();
  }

  private async refreshEntriesFromCanonicalRuns(): Promise<void> {
    const recovered = new Map<string, HarnessExperimentRunStoreEntry>();
    for (const child of await readdir(this.runsDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
      const loaded = await this.loadDirectory(child.name);
      if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
      if (recovered.has(loaded.entry.runSetId)) throw new Error("Experiment run store contains duplicate runSetId authority.");
      recovered.set(loaded.entry.runSetId, loaded.entry);
    }
    this.entries.clear();
    for (const [runSetId, entry] of recovered) this.entries.set(runSetId, entry);
  }

  /**
   * Rebuild only the derived index projection from each canonical head. Full
   * revision-transition and episode-sidecar verification remains on open/get/
   * list. Replaying every historical revision after every mutation made the
   * write path quadratic as a long-lived server accumulated runs.
   */
  private async refreshIndexEntriesFromCanonicalHeads(): Promise<void> {
    const recovered = new Map<string, HarnessExperimentRunStoreEntry>();
    for (const child of await readdir(this.runsDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
      const runDirectory = path.join(this.runsDirectory, child.name);
      const revisionsDirectory = path.join(runDirectory, REVISIONS_DIRECTORY);
      await assertDirectoryInside(this.runsDirectory, runDirectory, "Stored experiment run directory is not safe.");
      await assertDirectoryInside(runDirectory, revisionsDirectory, "Stored experiment revisions directory is not safe.");
      const revisionEntries = (await readdir(revisionsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && REVISION_DIRECTORY_PATTERN.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (!revisionEntries.length) throw new Error("Stored experiment run has no canonical revision.");
      for (const [position, entry] of revisionEntries.entries()) {
        const revision = Number(REVISION_DIRECTORY_PATTERN.exec(entry.name)![1]);
        if (revision !== position + 1) throw new Error("Experiment run revisions must be contiguous and ordered.");
      }
      const latest = revisionEntries.at(-1)!;
      const revision = revisionEntries.length;
      const revisionDirectory = path.join(revisionsDirectory, latest.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment revision directory is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentRunRecord;
      const manifest = JSON.parse(manifestText) as HarnessExperimentRunManifest;
      assertRunRecord(record);
      assertManifest(manifest, record, child.name, revision, recordText, latest.name);
      if (directoryKeyForRunSetId(record.runSetId) !== child.name) {
        throw new Error("Stored experiment run directory key does not match runSetId.");
      }
      if (recovered.has(record.runSetId)) throw new Error("Experiment run store contains duplicate runSetId authority.");
      recovered.set(record.runSetId, entryFromRecord(record, child.name, revision));
    }
    this.entries.clear();
    for (const [runSetId, entry] of recovered) this.entries.set(runSetId, entry);
  }

  private async acquireRunLease(runSetId: string, nonblocking = true): Promise<ChildProcessWithoutNullStreams> {
    const directoryKey = directoryKeyForRunSetId(runSetId);
    const lockDirectory = path.join(this.locksDirectory, `${directoryKey}.lock`);
    try {
      await mkdir(lockDirectory, { recursive: false });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectoryInside(this.locksDirectory, lockDirectory, "Experiment run lease path is not safe.");

    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", ...(nonblocking ? ["--nonblock"] : []), lockDirectory, "/bin/sh", "-c", `printf '${RUN_LEASE_ACQUIRED_MARKER}'; cat >/dev/null`],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    try {
      await waitForRunLease(child, runSetId);
      return child;
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      throw error;
    }
  }

  private async referencesForRunSet<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>,
    header: HarnessExperimentRunRecord
  ): Promise<HarnessExperimentRunEpisodeReferenceV1[]> {
    const errors = validateGenericTournamentRunSetArtifact(runSet);
    if (errors.length) throw new Error(`Experiment run-set is invalid: ${errors.join(" ")}`);
    if (!runSet.experiment || hashStableJsonValue(runSet.experiment) !== hashStableJsonValue(header.experiment)) {
      throw new Error("Experiment run-set provenance does not match its durable header.");
    }
    if (runSet.runSetId !== header.runSetId) throw new Error("Experiment run-set id does not match its durable header.");
    const runIds = new Set<string>();
    const refs: HarnessExperimentRunEpisodeReferenceV1[] = [];
    for (const episode of runSet.episodes) {
      refs.push(await this.referenceForEpisode(episode, header, runIds));
    }
    return refs;
  }

  private async referenceForEpisode<TEmbeddedArtifact extends TArtifact>(
    episode: GenericTournamentRunSetEpisode<TEmbeddedArtifact>,
    header: HarnessExperimentRunRecord,
    runIds: Set<string>
  ): Promise<HarnessExperimentRunEpisodeReferenceV1> {
    const expectedSeed = `${header.experiment.spec.seed}:g${episode.index + 1}`;
    if (episode.index < 0 || !Number.isInteger(episode.index) || episode.seed !== expectedSeed) {
      throw new Error("Experiment run episode ordering or seed does not match its durable schedule.");
    }
    if (!episode.artifact) {
      if (episode.status !== "failed" || episode.runId || episode.evaluationReport) {
        throw new Error("Only a reviewed pre-artifact failure may omit canonical episode content.");
      }
      return {
        index: episode.index,
        seed: episode.seed,
        status: "failed",
        metricCount: 0,
        failureCount: 0,
        error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
      };
    }
    if (!episode.runId || runIds.has(episode.runId)) {
      throw new Error("Experiment run-set episode runId must be present and unique when an artifact exists.");
    }
    runIds.add(episode.runId);
    const canonical = await this.episodeStore.get(episode.runId);
    if (!canonical) throw new Error(`Canonical episode ${episode.runId} is missing from the episode store.`);
    if (hashStableJsonValue(canonical) !== hashStableJsonValue(episode.artifact)) {
      throw new Error(`Canonical episode ${episode.runId} does not match the run-set artifact.`);
    }
    if (canonical.status !== episode.status) throw new Error(`Canonical episode ${episode.runId} lifecycle does not match the run-set.`);
    if (!canonical.experiment || hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(header.experiment)) {
      throw new Error(`Canonical episode ${episode.runId} experiment does not match the run header.`);
    }
    const metrics = await this.episodeStore.getMetrics(episode.runId);
    const failures = await this.episodeStore.getFailures(episode.runId);
    const evaluationReport = await this.episodeStore.getEvaluationReport(episode.runId);
    if (!metrics || !failures) throw new Error(`Canonical episode ${episode.runId} sidecars are missing.`);
    if (
      (evaluationReport === undefined) !== (episode.evaluationReport === undefined) ||
      (evaluationReport && episode.evaluationReport &&
        hashStableJsonValue(evaluationReport) !== hashStableJsonValue(episode.evaluationReport))
    ) {
      throw new Error(`Canonical episode ${episode.runId} evaluation report does not match the run-set.`);
    }
    return {
      index: episode.index,
      seed: episode.seed,
      status: episode.status,
      runId: episode.runId,
      artifactSha256: hashStableJsonValue(canonical),
      metricCount: metrics.length,
      failureCount: failures.length,
      ...(evaluationReport ? {
        evaluationReportId: evaluationReport.id,
        evaluationReportSha256: hashStableJsonValue(evaluationReport)
      } : {}),
      ...(episode.status === "failed" ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } : {})
    };
  }

  private async loadKnownRun(runSetId: string): Promise<{ record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined> {
    assertIdentifier(runSetId, "runSetId");
    const directoryKey = directoryKeyForRunSetId(runSetId);
    try {
      const stat = await lstat(path.join(this.runsDirectory, directoryKey));
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const loaded = await this.loadDirectory(directoryKey, runSetId);
    if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
    this.entries.set(runSetId, loaded.entry);
    return loaded;
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunSetId?: string
  ): Promise<{ record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined> {
    if (!DIRECTORY_KEY_PATTERN.test(directoryKey)) return undefined;
    const runDirectory = path.join(this.runsDirectory, directoryKey);
    const revisionsDirectory = path.join(runDirectory, REVISIONS_DIRECTORY);
    await assertDirectoryInside(this.runsDirectory, runDirectory, "Stored experiment run directory is not safe.");
    await assertDirectoryInside(runDirectory, revisionsDirectory, "Stored experiment revisions directory is not safe.");
    const revisionEntries = await readdir(revisionsDirectory, { withFileTypes: true });
    for (const child of revisionEntries) {
      if (REVISION_DIRECTORY_PATTERN.test(child.name) && (!child.isDirectory() || child.isSymbolicLink())) {
        throw new Error("Stored experiment revision path is not a safe directory.");
      }
    }
    const children = revisionEntries
      .filter((child) => child.isDirectory() && REVISION_DIRECTORY_PATTERN.test(child.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!children.length) throw new Error("Stored experiment run has no canonical revision.");
    let latest: { record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined;
    let header: HarnessExperimentRunRecord | undefined;
    let previous: HarnessExperimentRunRecord | undefined;
    for (const [position, child] of children.entries()) {
      const match = REVISION_DIRECTORY_PATTERN.exec(child.name)!;
      const revision = Number(match[1]);
      if (revision !== position + 1) throw new Error("Experiment run revisions must be contiguous and ordered.");
      const revisionDirectory = path.join(revisionsDirectory, child.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment revision directory is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentRunRecord;
      const manifest = JSON.parse(manifestText) as HarnessExperimentRunManifest;
      assertRunRecord(record);
      assertManifest(manifest, record, directoryKey, revision, recordText, child.name);
      if (revision === 1) {
        if (record.state !== "active" || record.episodes.length !== 0) {
          throw new Error("First experiment run revision must be an empty active header.");
        }
        header = record;
      } else {
        if (!header || !previous) throw new Error("Experiment run revision is missing its active header.");
        if (
          record.runSetId !== header.runSetId ||
          record.createdAt !== header.createdAt ||
          record.gamesRequested !== header.gamesRequested ||
          hashStableJsonValue(record.experiment) !== hashStableJsonValue(header.experiment)
        ) {
          throw new Error("Experiment run revision changed immutable header authority.");
        }
        if (previous.state === "finalized") throw new Error("Finalized experiment run cannot have a later revision.");
        if (Date.parse(record.updatedAt) < Date.parse(previous.updatedAt)) {
          throw new Error("Experiment run revision updatedAt moved backwards.");
        }
        if (record.state === "active") assertActiveProgressTransition(previous, record);
        else {
          if (previous.schemaVersion !== record.schemaVersion) throw new Error("Experiment run finalization changed record schema version.");
          assertEpisodeReferencesEqual(previous.episodes, record.episodes);
        }
      }
      if (expectedRunSetId && record.runSetId !== expectedRunSetId) throw new Error("Stored experiment run id does not match the registry.");
      await this.assertEpisodeReferences(record);
      latest = { record, entry: entryFromRecord(record, directoryKey, revision) };
      previous = record;
    }
    if (!latest) throw new Error("Stored experiment run has no recoverable canonical revision.");
    if (directoryKeyForRunSetId(latest.record.runSetId) !== directoryKey) {
      throw new Error("Stored experiment run directory key does not match runSetId.");
    }
    return latest;
  }

  private async assertEpisodeReferences(record: HarnessExperimentRunRecord): Promise<void> {
    for (const episode of record.episodes) {
      if (!episode.runId) continue;
      const canonical = await this.episodeStore.get(episode.runId);
      const metrics = await this.episodeStore.getMetrics(episode.runId);
      const failures = await this.episodeStore.getFailures(episode.runId);
      const evaluationReport = await this.episodeStore.getEvaluationReport(episode.runId);
      if (!canonical || !metrics || !failures) throw new Error(`Stored experiment episode reference ${episode.runId} is unresolved.`);
      if (hashStableJsonValue(canonical) !== episode.artifactSha256) throw new Error(`Stored experiment episode ${episode.runId} digest mismatch.`);
      if (canonical.status !== episode.status) throw new Error(`Stored experiment episode ${episode.runId} lifecycle mismatch.`);
      if (
        !canonical.experiment ||
        hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(record.experiment)
      ) {
        throw new Error(`Stored experiment episode ${episode.runId} provenance mismatch.`);
      }
      if (metrics.length !== episode.metricCount || failures.length !== episode.failureCount) {
        throw new Error(`Stored experiment episode ${episode.runId} sidecar count mismatch.`);
      }
      if (episode.evaluationReportId === undefined || episode.evaluationReportSha256 === undefined) {
        if (evaluationReport !== undefined) throw new Error(`Stored experiment episode ${episode.runId} has an unbound evaluation report.`);
      } else if (
        !evaluationReport ||
        evaluationReport.id !== episode.evaluationReportId ||
        hashStableJsonValue(evaluationReport) !== episode.evaluationReportSha256
      ) {
        throw new Error(`Stored experiment episode ${episode.runId} evaluation report mismatch.`);
      }
    }
  }

  private async writeRevision(
    revisionsDirectory: string,
    directoryKey: string,
    revision: number,
    record: HarnessExperimentRunRecord
  ): Promise<void> {
    const recordText = jsonDocument(record);
    const recordSha256 = sha256(recordText);
    const revisionName = revisionSlotDirectoryName(revision);
    const finalDirectory = path.join(revisionsDirectory, revisionName);
    const temporaryDirectory = path.join(revisionsDirectory, `.tmp-${randomUUID()}`);
    try {
      await assertPathMissing(finalDirectory, "Experiment run revision CAS slot already exists.");
      await mkdir(temporaryDirectory, { recursive: false });
      const commonManifest = {
        kind: "experiment-run-manifest" as const,
        runSetId: record.runSetId,
        directoryKey,
        revision,
        state: record.state,
        recordSha256,
        files: { record: RECORD_FILE, manifest: MANIFEST_FILE } as const
      };
      const manifest: HarnessExperimentRunManifest = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2
        ? {
            schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2,
            recordSchemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
            ...commonManifest
          }
        : record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
          ? {
              schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3,
              recordSchemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
              ...commonManifest
            }
          : { schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION, ...commonManifest };
      await writeFile(path.join(temporaryDirectory, RECORD_FILE), recordText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      try {
        await lstat(finalDirectory);
        throw new ExperimentRevisionCasConflict(revision);
      } catch (publishedError) {
        if (publishedError instanceof ExperimentRevisionCasConflict) throw publishedError;
        if (!isMissing(publishedError)) throw publishedError;
      }
      throw error;
    }
  }

  private async writeIndex(): Promise<void> {
    const lease = await this.acquireRunLease("__experiment_run_index__", false);
    try {
      // index.json is a rebuildable projection. Refresh while holding one
      // global index lease so concurrent writers for different run ids cannot
      // erase one another through last-writer-wins rename.
      await this.refreshIndexEntriesFromCanonicalHeads();
      const index: HarnessExperimentRunStoreIndexV1 = {
        schemaVersion: HARNESS_EXPERIMENT_RUN_INDEX_VERSION,
        kind: "experiment-run-index",
        updatedAt: this.now(),
        entries: [...this.entries.values()].sort(compareEntries).map((entry) => structuredClone(entry))
      };
      const target = path.join(this.root, INDEX_FILE);
      await assertWritableFileTarget(target, "Experiment run index is not a safe regular file.");
      const temporary = path.join(this.root, `.index-${randomUUID()}.tmp`);
      await writeFile(temporary, jsonDocument(index), { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } finally {
      await releaseRunLease(lease);
    }
  }
}
