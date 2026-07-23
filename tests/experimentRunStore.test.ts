import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEpisodeArtifactEnvelope } from "../src/harness/episodeArtifacts";
import { createGenericExperimentProvenance, type GenericExperimentSpecV1 } from "../src/harness/experimentSpec";
import { HarnessExperimentRunStore } from "../src/harness/experimentRunStore";
import type { GenericTournamentRunSetArtifact } from "../src/harness/genericTournamentArtifacts";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "../src/harness/tournamentRunner";

type Artifact = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("restart-safe experiment run store", () => {
  it("converges concurrent run creation and same-slot mutation across independent store instances", async () => {
    const root = await temporaryRoot();
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const [first, second] = await Promise.all([
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }),
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority })
    ]);

    const begun = await Promise.all([
      first.beginOrResume({ runSetId: "concurrent-cas", experiment, createdAt: "2026-07-22T15:00:00.000Z" }),
      second.beginOrResume({ runSetId: "concurrent-cas", experiment, createdAt: "2026-07-22T15:00:00.000Z" })
    ]);
    expect(begun.map((entry) => entry.disposition).sort()).toEqual(["active", "created"]);

    const started = await Promise.all([
      first.startEpisode({ runSetId: "concurrent-cas", index: 0, seed: `${experiment.spec.seed}:g1` }),
      second.startEpisode({ runSetId: "concurrent-cas", index: 0, seed: `${experiment.spec.seed}:g1` })
    ]);
    expect(started[0]).toEqual(started[1]);
    expect(started[0].currentEpisode?.phase).toBe("started");

    const revisions = await revisionDirectory(root, "concurrent-cas");
    expect((await readdir(revisions)).filter((name) => /^\d{12}(?:-|$)/.test(name)).sort()).toEqual([
      "000000000001",
      "000000000002"
    ]);
    await expect(HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }))
      .resolves.toBeDefined();
  });

  it("holds a kernel-released run lease for the complete live operation", async () => {
    const root = await temporaryRoot();
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const [first, second] = await Promise.all([
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }),
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority })
    ]);
    let release!: () => void;
    const held = first.withRunLease("lease-run", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "released";
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(second.withRunLease("lease-run", async () => "wrong"))
      .rejects.toThrow(/already active in another process/i);
    release();
    await expect(held).resolves.toBe("released");
    await expect(second.withRunLease("lease-run", async () => "reacquired"))
      .resolves.toBe("reacquired");
  });

  it("publishes the active schedule before preparation and recovers without executing episode authority", async () => {
    const root = await temporaryRoot();
    const reads = { artifacts: 0, metrics: 0, failures: 0, evaluations: 0 };
    const authority = emptyAuthority(reads);
    const experiment = createGenericExperimentProvenance(experimentSpec(2));
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });

    await store.begin({
      runSetId: "restart-safe-run",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });

    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect(await restarted.get("restart-safe-run")).toMatchObject({
      state: "active",
      gamesRequested: 2,
      gamesCompleted: 0,
      gamesUnstarted: 2,
      episodes: []
    });
    expect(await restarted.list()).toMatchObject([{ runSetId: "restart-safe-run", revision: 1, state: "active" }]);
    expect(reads).toEqual({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    await expect(restarted.begin({ runSetId: "restart-safe-run", experiment })).rejects.toThrow(/already exists/i);
  });

  it("finalizes reviewed pre-artifact failure references and rejects revision rollback through a symlink", async () => {
    const root = await temporaryRoot();
    const reads = { artifacts: 0, metrics: 0, failures: 0, evaluations: 0 };
    const authority = emptyAuthority(reads);
    const experiment = createGenericExperimentProvenance(experimentSpec(2));
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({ runSetId: "failed-run", experiment, createdAt: "2026-07-22T15:00:00.000Z" });

    const runSet: GenericTournamentRunSetArtifact<Artifact> = {
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: experiment.spec.domainId,
      runSetId: "failed-run",
      createdAt: "2026-07-22T15:00:00.000Z",
      seed: experiment.spec.seed,
      gamesRequested: 2,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 1,
      gamesUnstarted: 1,
      experiment,
      episodes: [{
        index: 0,
        seed: `${experiment.spec.seed}:g1`,
        status: "failed",
        error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
      }]
    };
    await store.recordEpisode({ runSetId: "failed-run", episode: runSet.episodes[0]! });
    await store.finalize(runSet);

    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect(await restarted.get("failed-run")).toMatchObject({
      state: "finalized",
      gamesFailed: 1,
      gamesUnstarted: 1,
      episodes: [{ status: "failed", error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE }]
    });
    expect(reads).toEqual({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });

    const revisions = await revisionDirectory(root, "failed-run");
    const names = (await readdir(revisions)).sort();
    const finalRevision = names.at(-1)!;
    const backup = path.join(revisions, ".finalized-backup");
    await rename(path.join(revisions, finalRevision), backup);
    await symlink(".finalized-backup", path.join(revisions, finalRevision), "dir");
    await expect(HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }))
      .rejects.toThrow(/revision path is not a safe directory/i);
  });

  it("persists each terminal episode as a restart-safe active prefix before finalization", async () => {
    const root = await temporaryRoot();
    const reads = { artifacts: 0, metrics: 0, failures: 0, evaluations: 0 };
    const authority = emptyAuthority(reads);
    const experiment = createGenericExperimentProvenance(experimentSpec(3));
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({ runSetId: "progress-run", experiment, createdAt: "2026-07-22T15:00:00.000Z" });

    const firstFailure = {
      index: 0,
      seed: `${experiment.spec.seed}:g1`,
      status: "failed" as const,
      error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
    };
    const first = await store.recordEpisode({ runSetId: "progress-run", episode: firstFailure });
    expect(first).toMatchObject({ revision: 2, state: "active", gamesFailed: 1, gamesUnstarted: 2 });

    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect(await restarted.get("progress-run")).toMatchObject({
      state: "active",
      gamesRequested: 3,
      gamesFailed: 1,
      gamesUnstarted: 2,
      episodes: [firstFailure]
    });
    expect(reads).toEqual({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });

    const duplicate = await restarted.recordEpisode({ runSetId: "progress-run", episode: firstFailure });
    expect(duplicate.revision).toBe(2);
    await expect(
      restarted.recordEpisode({
        runSetId: "progress-run",
        episode: {
          index: 2,
          seed: `${experiment.spec.seed}:g3`,
          status: "failed",
          error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
        }
      })
    ).rejects.toThrow(/contiguous and ordered/i);

    const secondFailure = {
      index: 1,
      seed: `${experiment.spec.seed}:g2`,
      status: "failed" as const,
      error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
    };
    await restarted.recordEpisode({ runSetId: "progress-run", episode: secondFailure });
    const runSet: GenericTournamentRunSetArtifact<Artifact> = {
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: experiment.spec.domainId,
      runSetId: "progress-run",
      createdAt: "2026-07-22T15:00:00.000Z",
      seed: experiment.spec.seed,
      gamesRequested: 3,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 2,
      gamesUnstarted: 1,
      experiment,
      episodes: [firstFailure, secondFailure]
    };
    const finalized = await restarted.finalize(runSet);
    expect(finalized).toMatchObject({ revision: 4, state: "finalized", gamesFailed: 2, gamesUnstarted: 1 });
    const reopened = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect(await reopened.get("progress-run")).toMatchObject({
      state: "finalized",
      gamesFailed: 2,
      gamesUnstarted: 1,
      episodes: [firstFailure, secondFailure]
    });
  });

  it("treats an identical artifact-backed terminal episode retry as idempotent", async () => {
    const root = await temporaryRoot();
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const artifact = {
      runId: "artifact-backed-retry:g1",
      status: "completed",
      experiment
    } as unknown as Artifact;
    const authority = {
      async get(runId: string) {
        return runId === artifact.runId ? structuredClone(artifact) : undefined;
      },
      async getMetrics() {
        return [];
      },
      async getFailures() {
        return [];
      },
      async getEvaluationReport() {
        return undefined;
      }
    };
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({ runSetId: "artifact-backed-retry", experiment });
    const episode = {
      index: 0,
      seed: `${experiment.spec.seed}:g1`,
      status: "completed" as const,
      runId: artifact.runId,
      artifact
    };

    const first = await store.recordEpisode({ runSetId: "artifact-backed-retry", episode });
    const retry = await store.recordEpisode({ runSetId: "artifact-backed-retry", episode });

    expect(first).toMatchObject({ revision: 2, gamesCompleted: 1, gamesUnstarted: 0 });
    expect(retry).toEqual(first);
  });

  it("persists and recovers the v2 started and staged episode lifecycle", async () => {
    const root = await temporaryRoot();
    const experiment = createGenericExperimentProvenance(experimentSpec(2));
    const artifacts = new Map<string, Artifact>();
    const authority = {
      async get(runId: string) { return artifacts.get(runId); },
      async getMetrics(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getFailures(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getEvaluationReport() { return undefined; }
    };
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    const begun = await store.beginOrResume({
      runSetId: "v2-recovery",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });
    expect(begun).toMatchObject({ disposition: "created", record: { schemaVersion: "harness.experiment-run-record.v2" } });

    await store.startEpisode({ runSetId: "v2-recovery", index: 0, seed: `${experiment.spec.seed}:g1` });
    const afterStart = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect(await afterStart.get("v2-recovery")).toMatchObject({
      gamesInFlight: 1,
      gamesUnstarted: 1,
      currentEpisode: { phase: "started", index: 0, seed: `${experiment.spec.seed}:g1` }
    });

    const interrupted = await afterStart.recoverCurrentEpisode("v2-recovery");
    expect(interrupted).toMatchObject({
      disposition: "failed-interrupted-start",
      record: { gamesFailed: 1, gamesInFlight: 0, episodes: [{ index: 0, status: "failed" }] }
    });

    await afterStart.startEpisode({ runSetId: "v2-recovery", index: 1, seed: `${experiment.spec.seed}:g2` });
    const artifact = {
      runId: "v2-recovery-artifact",
      status: "completed",
      experiment
    } as unknown as Artifact;
    await afterStart.stageEpisode({
      runSetId: "v2-recovery",
      episode: { index: 1, seed: `${experiment.spec.seed}:g2`, status: "completed", runId: artifact.runId, artifact }
    });
    artifacts.set(artifact.runId, artifact);

    const stagedRestart = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    const adopted = await stagedRestart.recoverCurrentEpisode("v2-recovery");
    expect(adopted).toMatchObject({
      disposition: "committed-staged-artifact",
      record: { gamesCompleted: 1, gamesFailed: 1, gamesInFlight: 0, gamesUnstarted: 0 }
    });
    expect(adopted.record.currentEpisode).toBeUndefined();
    expect(adopted.record.episodes.map((episode) => episode.index)).toEqual([0, 1]);
    expect((await stagedRestart.beginOrResume({ runSetId: "v2-recovery", experiment })).revision).toBe(6);
  });

  it("makes finalization and the last terminal retry idempotent without accepting drift", async () => {
    const root = await temporaryRoot();
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({
      runSetId: "finalize-retry",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });
    const episode = {
      index: 0,
      seed: `${experiment.spec.seed}:g1`,
      status: "failed" as const,
      error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
    };
    await store.recordEpisode({ runSetId: "finalize-retry", episode });
    const runSet: GenericTournamentRunSetArtifact<Artifact> = {
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: experiment.spec.domainId,
      runSetId: "finalize-retry",
      createdAt: "2026-07-22T15:00:00.000Z",
      seed: experiment.spec.seed,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 1,
      gamesUnstarted: 0,
      experiment,
      episodes: [episode]
    };

    const finalized = await store.finalize(runSet);
    expect(await store.finalize(structuredClone(runSet))).toEqual(finalized);
    expect(await store.recordEpisode({ runSetId: "finalize-retry", episode })).toEqual(finalized);
    await expect(store.recordEpisode({
      runSetId: "finalize-retry",
      episode: { ...episode, seed: "different:g1" }
    })).rejects.toThrow(/does not match its durable schedule/i);
  });

  it("requires finalization to exactly match the durable terminal prefix", async () => {
    const root = await temporaryRoot();
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({
      runSetId: "no-finalize-backfill",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });
    const episode = {
      index: 0,
      seed: `${experiment.spec.seed}:g1`,
      status: "failed" as const,
      error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
    };
    await expect(store.finalize({
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: experiment.spec.domainId,
      runSetId: "no-finalize-backfill",
      createdAt: "2026-07-22T15:00:00.000Z",
      seed: experiment.spec.seed,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 1,
      gamesUnstarted: 0,
      experiment,
      episodes: [episode]
    })).rejects.toThrow(/does not match durable episode progress/i);
  });

  it("keeps revision timestamps monotonic when the wall clock moves backwards", async () => {
    const root = await temporaryRoot();
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const store = await HarnessExperimentRunStore.open({
      baseDirectory: root,
      episodeStore: authority,
      now: () => "2026-07-22T14:59:00.000Z"
    });
    await store.begin({
      runSetId: "clock-rollback",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });
    const episode = {
      index: 0,
      seed: `${experiment.spec.seed}:g1`,
      status: "failed" as const,
      error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
    };
    await store.recordEpisode({ runSetId: "clock-rollback", episode });
    const runSet: GenericTournamentRunSetArtifact<Artifact> = {
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: experiment.spec.domainId,
      runSetId: "clock-rollback",
      createdAt: "2026-07-22T15:00:00.000Z",
      seed: experiment.spec.seed,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 1,
      gamesUnstarted: 0,
      experiment,
      episodes: [episode]
    };
    await store.finalize(runSet);

    const record = await store.get("clock-rollback");
    expect(record?.updatedAt).toBe("2026-07-22T15:00:00.000Z");
    await expect(HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }))
      .resolves.toBeDefined();
  });

  it("fails closed when a formally published record is changed without its manifest", async () => {
    const root = await temporaryRoot();
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const experiment = createGenericExperimentProvenance(experimentSpec(1));
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.begin({ runSetId: "tampered-run", experiment, createdAt: "2026-07-22T15:00:00.000Z" });

    const revisions = await revisionDirectory(root, "tampered-run");
    const revision = (await readdir(revisions))[0]!;
    const recordPath = path.join(revisions, revision, "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    record.gamesRequested = 999;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await expect(HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }))
      .rejects.toThrow(/gamesRequested does not match|manifest does not match/i);
  });

  it("uses v3 only for multi-attempt runs and preserves an append-only retry ledger through restart", async () => {
    const root = await temporaryRoot();
    const artifacts = new Map<string, Artifact>();
    const authority = {
      async get(runId: string) { return artifacts.get(runId); },
      async getMetrics(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getFailures(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getEvaluationReport() { return undefined; }
    };
    const single = createGenericExperimentProvenance(experimentSpec(1));
    const multi = createGenericExperimentProvenance({
      ...experimentSpec(1),
      retryPolicy: { id: "ledger.retry", version: "2", maxAttempts: 3, backoffMs: 1_000 }
    });
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    expect((await store.beginOrResume({ runSetId: "v2-single", experiment: single })).record.schemaVersion)
      .toBe("harness.experiment-run-record.v2");
    expect((await store.beginOrResume({ runSetId: "v3-retry", experiment: multi, createdAt: "2026-07-23T01:00:00.000Z" })).record.schemaVersion)
      .toBe("harness.experiment-run-record.v3");

    const firstStarted = await store.startEpisode({
      runSetId: "v3-retry",
      index: 0,
      seed: `${multi.spec.seed}:g1`,
      startedAt: "2026-07-23T01:00:01.000Z"
    });
    expect(firstStarted).toMatchObject({
      gamesInFlight: 1,
      gamesUnstarted: 0,
      currentEpisode: { phase: "started", ordinal: 1, priorAttempts: [] }
    });
    const firstAttemptId = firstStarted.currentEpisode!.attemptId;
    const waiting = await store.scheduleEpisodeRetry({
      runSetId: "v3-retry",
      code: "counter.prepare-temporary",
      scheduledAt: "2026-07-23T01:00:02.000Z",
      backoffMs: 1_000
    });
    expect(waiting).toMatchObject({
      gamesInFlight: 1,
      gamesUnstarted: 0,
      currentEpisode: {
        phase: "retry-wait",
        ordinal: 1,
        attemptId: firstAttemptId,
        eligibleAt: "2026-07-23T01:00:03.000Z",
        code: "counter.prepare-temporary"
      }
    });

    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await expect(restarted.recoverCurrentEpisode("v3-retry")).resolves.toMatchObject({
      disposition: "retry-wait",
      record: { gamesInFlight: 1, currentEpisode: { phase: "retry-wait" } }
    });
    await expect(restarted.startEpisode({
      runSetId: "v3-retry",
      index: 0,
      seed: `${multi.spec.seed}:g1`,
      startedAt: "2026-07-23T01:00:02.999Z"
    })).rejects.toThrow(/not eligible/i);

    const secondStarted = await restarted.startEpisode({
      runSetId: "v3-retry",
      index: 0,
      seed: `${multi.spec.seed}:g1`,
      startedAt: "2026-07-23T01:00:03.000Z"
    });
    expect(secondStarted).toMatchObject({
      gamesUnstarted: 0,
      currentEpisode: {
        phase: "started",
        ordinal: 2,
        priorAttempts: [{
          ordinal: 1,
          attemptId: firstAttemptId,
          outcome: "retry-scheduled",
          code: "counter.prepare-temporary"
        }]
      }
    });
    expect(secondStarted.currentEpisode!.attemptId).not.toBe(firstAttemptId);

    const artifact = { runId: "v3-retry:g1", status: "completed", experiment: multi } as unknown as Artifact;
    await restarted.stageEpisode({
      runSetId: "v3-retry",
      stagedAt: "2026-07-23T01:00:04.000Z",
      episode: { index: 0, seed: `${multi.spec.seed}:g1`, status: "completed", runId: artifact.runId, artifact }
    });
    artifacts.set(artifact.runId, artifact);
    await restarted.recordEpisode({
      runSetId: "v3-retry",
      episode: { index: 0, seed: `${multi.spec.seed}:g1`, status: "completed", runId: artifact.runId, artifact }
    });
    const terminal = await restarted.get("v3-retry");
    expect(terminal).toMatchObject({
      schemaVersion: "harness.experiment-run-record.v3",
      gamesCompleted: 1,
      gamesInFlight: 0,
      episodes: [{
        acceptedAttemptId: secondStarted.currentEpisode!.attemptId,
        attempts: [
          { ordinal: 1, attemptId: firstAttemptId, outcome: "retry-scheduled" },
          { ordinal: 2, attemptId: secondStarted.currentEpisode!.attemptId, outcome: "artifact-committed" }
        ]
      }]
    });
    expect(JSON.stringify(terminal)).not.toMatch(/exception|provider|temporary failure text/i);
    await restarted.finalize({
      artifactVersion: "harness.tournament-run-set.v1",
      kind: "tournament-run-set",
      domainId: multi.spec.domainId,
      runSetId: "v3-retry",
      createdAt: "2026-07-23T01:00:00.000Z",
      seed: multi.spec.seed,
      gamesRequested: 1,
      gamesCompleted: 1,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesUnstarted: 0,
      experiment: multi,
      episodes: [{ index: 0, seed: `${multi.spec.seed}:g1`, status: "completed", runId: artifact.runId, artifact }]
    });
    await expect(HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }))
      .resolves.toBeDefined();
  });

  it("fails closed on unsafe retry codes, scheduling drift, exhaustion, and an ambiguous started crash", async () => {
    const root = await temporaryRoot();
    const authority = emptyAuthority({ artifacts: 0, metrics: 0, failures: 0, evaluations: 0 });
    const experiment = createGenericExperimentProvenance({
      ...experimentSpec(1),
      retryPolicy: { id: "ledger.retry", version: "2", maxAttempts: 2 }
    });
    const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await store.beginOrResume({ runSetId: "v3-exhaustion", experiment, createdAt: "2026-07-23T02:00:00.000Z" });
    await store.startEpisode({
      runSetId: "v3-exhaustion", index: 0, seed: `${experiment.spec.seed}:g1`, startedAt: "2026-07-23T02:00:01.000Z"
    });
    await expect(store.scheduleEpisodeRetry({
      runSetId: "v3-exhaustion", code: "raw exception: secret", scheduledAt: "2026-07-23T02:00:02.000Z", backoffMs: 0
    })).rejects.toThrow(/safe reviewed classifier code/i);
    await store.scheduleEpisodeRetry({
      runSetId: "v3-exhaustion", code: "counter.run-timeout", scheduledAt: "2026-07-23T02:00:02.000Z", backoffMs: 0
    });
    await expect(store.scheduleEpisodeRetry({
      runSetId: "v3-exhaustion", code: "counter.run-timeout", scheduledAt: "2026-07-23T02:00:03.000Z", backoffMs: 0
    })).rejects.toThrow(/conflicts with durable authority/i);
    await store.startEpisode({
      runSetId: "v3-exhaustion", index: 0, seed: `${experiment.spec.seed}:g1`, startedAt: "2026-07-23T02:00:02.000Z"
    });
    await expect(store.scheduleEpisodeRetry({
      runSetId: "v3-exhaustion", code: "counter.run-timeout", scheduledAt: "2026-07-23T02:00:03.000Z", backoffMs: 0
    })).rejects.toThrow(/exceed maxAttempts/i);

    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    const recovered = await restarted.recoverCurrentEpisode("v3-exhaustion");
    expect(recovered).toMatchObject({
      disposition: "failed-interrupted-start",
      record: {
        gamesFailed: 1,
        gamesInFlight: 0,
        episodes: [{ attempts: [
          { ordinal: 1, outcome: "retry-scheduled" },
          { ordinal: 2, outcome: "interrupted-unknown" }
        ] }]
      }
    });
  });

  it("converges concurrent exact retry scheduling and adopts a staged v3 artifact after restart", async () => {
    const root = await temporaryRoot();
    const artifacts = new Map<string, Artifact>();
    const authority = {
      async get(runId: string) { return artifacts.get(runId); },
      async getMetrics(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getFailures(runId: string) { return artifacts.has(runId) ? [] : undefined; },
      async getEvaluationReport() { return undefined; }
    };
    const experiment = createGenericExperimentProvenance({
      ...experimentSpec(1),
      retryPolicy: { id: "ledger.retry", version: "2", maxAttempts: 2, backoffMs: 5 }
    });
    const [first, second] = await Promise.all([
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority }),
      HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority })
    ]);
    await first.beginOrResume({ runSetId: "v3-concurrent", experiment, createdAt: "2026-07-23T03:00:00.000Z" });
    await first.startEpisode({
      runSetId: "v3-concurrent", index: 0, seed: `${experiment.spec.seed}:g1`, startedAt: "2026-07-23T03:00:01.000Z"
    });
    const scheduled = await Promise.all([first, second].map((store) => store.scheduleEpisodeRetry({
      runSetId: "v3-concurrent",
      code: "counter.prepare-busy",
      scheduledAt: "2026-07-23T03:00:02.000Z",
      backoffMs: 5
    })));
    expect(scheduled[0]).toEqual(scheduled[1]);
    await first.startEpisode({
      runSetId: "v3-concurrent", index: 0, seed: `${experiment.spec.seed}:g1`, startedAt: "2026-07-23T03:00:02.005Z"
    });
    const artifact = { runId: "v3-concurrent:g1", status: "completed", experiment } as unknown as Artifact;
    await first.stageEpisode({
      runSetId: "v3-concurrent",
      stagedAt: "2026-07-23T03:00:03.000Z",
      episode: { index: 0, seed: `${experiment.spec.seed}:g1`, status: "completed", runId: artifact.runId, artifact }
    });
    artifacts.set(artifact.runId, artifact);
    const restarted = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
    await expect(restarted.recoverCurrentEpisode("v3-concurrent")).resolves.toMatchObject({
      disposition: "committed-staged-artifact",
      record: {
        gamesCompleted: 1,
        gamesInFlight: 0,
        episodes: [{ attempts: [
          { ordinal: 1, outcome: "retry-scheduled" },
          { ordinal: 2, outcome: "artifact-committed" }
        ] }]
      }
    });
  });
});

function emptyAuthority(reads: { artifacts: number; metrics: number; failures: number; evaluations: number }) {
  return {
    async get(): Promise<Artifact | undefined> {
      reads.artifacts += 1;
      return undefined;
    },
    async getMetrics() {
      reads.metrics += 1;
      return undefined;
    },
    async getFailures() {
      reads.failures += 1;
      return undefined;
    },
    async getEvaluationReport() {
      reads.evaluations += 1;
      return undefined;
    }
  };
}

function experimentSpec(episodeCount: number): GenericExperimentSpecV1 {
  return {
    version: "harness.experiment.v1",
    id: "run-store-experiment",
    kind: "tournament",
    domainId: "ledger-run-store",
    domainAdapter: {
      schemaVersion: "harness.domain-adapter.v1",
      domainId: "ledger-run-store",
      adapterId: "ledger-run-store.social",
      adapterVersion: "1",
      semanticHash: "ledger-run-store-adapter-v1",
      components: [
        { kind: "agent_state_schema", id: "ledger.state", version: "1", semanticHash: "state-v1" },
        { kind: "command_codec", id: "ledger.command", version: "1", semanticHash: "command-v1" },
        { kind: "environment", id: "ledger.environment", version: "1", semanticHash: "environment-v1" },
        { kind: "observation_projection", id: "ledger.observation", version: "1", semanticHash: "observation-v1" },
        { kind: "scheduler", id: "ledger.scheduler", version: "1", semanticHash: "scheduler-v1" }
      ]
    },
    seed: "run-store-seed",
    episodeCount,
    actorCount: 1,
    schedulerMode: "aec",
    profiles: [{ id: "ledger", version: "1", policyId: "ledger.policy" }],
    modelAssignments: [],
    assignmentPolicy: { id: "ledger.assignment", version: "1" },
    maxTransitions: 1,
    timeoutPolicy: { id: "ledger.timeout", version: "1", runTimeoutMs: 5_000 },
    retryPolicy: { id: "ledger.retry", version: "1", maxAttempts: 1 },
    evaluatorIds: [],
    artifactPolicy: { id: "ledger.artifact", version: "1", visibility: "research-full" },
    checkpointPolicy: { id: "ledger.checkpoint", version: "1", mode: "none" },
    continueOnError: false,
    domainConfig: {}
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "experiment-run-store-"));
  roots.push(root);
  return root;
}

async function revisionDirectory(root: string, runSetId: string): Promise<string> {
  const directoryKey = createHash("sha256").update(runSetId).digest("hex");
  return path.join(root, "runs", directoryKey, "revisions");
}
