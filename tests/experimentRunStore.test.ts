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
