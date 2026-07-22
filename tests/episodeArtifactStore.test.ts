import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";
import type { HarnessCheckpointEnvelope, HarnessEpisodeArtifactEnvelope } from "../src/harness/episodeArtifacts";
import { runEvaluationRegistry } from "../src/harness/evaluation";
import {
  HarnessEpisodeArtifactStore,
  buildHarnessCheckpointFromEpisode,
  deriveHarnessEpisodeTrajectoryJsonl,
  replaySocialEpisode,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  verifyHarnessEpisodeArtifact
} from "../src/harness/generic";
import { hashStableState } from "../src/harness/hash";
import { runHarnessEpisode } from "../src/harness/runner";
import type { SocialActor, SocialEnvironment } from "../src/harness/social";

interface CounterState {
  value: number;
  done: boolean;
}

interface CounterPending {
  actorId: "counter-a";
  kind: "increment";
}

interface CounterObservation {
  actorId: "counter-a";
  value: number;
}

interface CounterCommand {
  actorId: "counter-a";
  amount: 1;
}

interface CounterAgentState {
  actorId: "counter-a";
  committedValue: number;
}

type CounterArtifact = HarnessEpisodeArtifactEnvelope<
  CounterState,
  CounterObservation,
  CounterPending,
  CounterCommand,
  CounterAgentState
>;

type CounterCheckpoint = HarnessCheckpointEnvelope<
  CounterState,
  CounterAgentState,
  CounterObservation,
  CounterPending,
  CounterCommand
>;

const counterAdapter: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: "counter-ledger",
  adapterId: "counter-ledger.social",
  adapterVersion: "1",
  semanticHash: hashStableState({ adapter: "counter-ledger.social", version: 1 }),
  components: [
    { kind: "agent_state_schema", id: "counter.agent", version: "1", semanticHash: hashStableState({ committedValue: 1 }) },
    { kind: "command_codec", id: "counter.command", version: "1", semanticHash: hashStableState({ increment: 1 }) },
    { kind: "environment", id: "counter.environment", version: "1", semanticHash: hashStableState({ terminal: 1 }) },
    { kind: "observation_projection", id: "counter.observation", version: "1", semanticHash: hashStableState({ scoped: true }) },
    { kind: "scheduler", id: "counter.scheduler", version: "1", semanticHash: hashStableState({ mode: "aec" }) }
  ]
};

class CounterEnvironment implements SocialEnvironment<CounterState, CounterObservation, CounterPending, CounterCommand> {
  private state: CounterState;

  constructor(initialState: CounterState = { value: 0, done: false }) {
    this.state = structuredClone(initialState);
  }

  snapshot(): CounterState {
    return structuredClone(this.state);
  }

  pendingActions(): CounterPending[] {
    return this.state.done ? [] : [{ actorId: "counter-a", kind: "increment" }];
  }

  observe(): CounterObservation {
    return { actorId: "counter-a", value: this.state.value };
  }

  validateAction(command: CounterCommand, pending: CounterPending) {
    return {
      valid: command.actorId === pending.actorId && command.amount === 1,
      code: "counter.increment"
    };
  }

  step(command: CounterCommand): CounterState {
    if (this.state.done || command.actorId !== "counter-a" || command.amount !== 1) {
      throw new Error("illegal counter command");
    }
    this.state = { value: this.state.value + 1, done: true };
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generic single-episode artifact store", () => {
  it("persists, rehydrates, and model-free verifies a non-Werewolf episode after restart", async () => {
    const root = await temporaryStoreRoot();
    let actorDecisionCalls = 0;
    const artifact = await buildCounterArtifact(() => {
      actorDecisionCalls += 1;
    });
    const verifier = counterVerifier();
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: verifier });

    const entry = await store.put(artifact);
    expect(entry).toMatchObject({ runId: artifact.runId, nativeStepCount: 1, messageCount: 0 });
    expect(await store.list()).toEqual([entry]);
    expect(await store.get(artifact.runId)).toEqual(artifact);
    expect(actorDecisionCalls).toBe(1);

    const restarted = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: verifier });
    expect(await restarted.list()).toEqual([entry]);
    const recovered = await restarted.get(artifact.runId);
    expect(recovered).toEqual(artifact);
    expect(recovered && verifier(recovered)).toMatchObject({ ok: true, mismatches: [] });
    expect(actorDecisionCalls).toBe(1);

    const trajectory = await readFile(path.join(root, "episodes", entry.directoryKey, "trajectory.jsonl"), "utf8");
    expect(trajectory).toBe(deriveHarnessEpisodeTrajectoryJsonl(artifact));
    expect(trajectory.trim().split("\n")).toHaveLength(2);
    expect(await restarted.getMetrics(artifact.runId)).toEqual([]);
    expect(await restarted.getFailures(artifact.runId)).toEqual([]);
    expect(await restarted.getEvaluationReport(artifact.runId)).toBeUndefined();
  });

  it("recovers the prior v1 artifact/trajectory layout without inventing evaluation evidence", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    const entry = await store.put(artifact);
    const directory = path.join(root, "episodes", entry.directoryKey);
    const artifactText = await readFile(path.join(directory, "artifact.json"), "utf8");
    const trajectoryText = await readFile(path.join(directory, "trajectory.jsonl"), "utf8");
    await rm(path.join(directory, "metrics.jsonl"));
    await rm(path.join(directory, "failures.jsonl"));
    await rm(path.join(directory, "evaluation-report.json"));
    await rm(path.join(directory, "checkpoints.index.json"));
    await rm(path.join(directory, "checkpoints"), { recursive: true });
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({
      schemaVersion: "harness.episode-store-manifest.v1",
      manifestKind: "episode-store-manifest",
      runId: artifact.runId,
      artifactVersion: artifact.artifactVersion,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      status: artifact.status,
      directoryKey: entry.directoryKey,
      nativeStepCount: artifact.socialEpisode.steps.length,
      messageCount: artifact.socialEpisode.messages.length,
      artifactSha256: rawSha256(artifactText),
      trajectorySha256: rawSha256(trajectoryText),
      files: { artifact: "artifact.json", trajectory: "trajectory.jsonl", manifest: "manifest.json" }
    }, null, 2)}\n`, "utf8");

    const restarted = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    expect(await restarted.get(artifact.runId)).toEqual(artifact);
    expect(await restarted.getMetrics(artifact.runId)).toEqual([]);
    expect(await restarted.getFailures(artifact.runId)).toEqual([]);
    expect(await restarted.getEvaluationReport(artifact.runId)).toBeUndefined();
    expect(await restarted.listCheckpoints(artifact.runId)).toEqual([]);
  });

  it("recovers the prior v2 metric/failure layout without inventing a complete evaluation report", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const report = runEvaluationRegistry({
      id: "legacy-v2-evaluation",
      context: {
        id: artifact.runId,
        status: artifact.status,
        initialState: artifact.initialState,
        finalState: artifact.finalState,
        agents: artifact.agents,
        trajectory: artifact.socialEpisode.steps
      },
      evaluators: [{
        id: "legacy.counter",
        label: "Legacy counter",
        version: "1",
        evaluate: () => ({
          evaluatorId: "legacy.counter",
          label: "Legacy counter",
          version: "1",
          metrics: [{ id: "legacy.value", label: "Legacy value", scope: "episode", value: 1, source: "legacy.counter" }]
        })
      }]
    });
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    const entry = await store.put(artifact, { evaluationReport: report });
    const directory = path.join(root, "episodes", entry.directoryKey);
    await rm(path.join(directory, "evaluation-report.json"));
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.schemaVersion = "harness.episode-store-manifest.v2";
    delete manifest.evaluationSha256;
    delete manifest.files.evaluation;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const restarted = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    expect(await restarted.getMetrics(artifact.runId)).toEqual(report.metrics);
    expect(await restarted.getFailures(artifact.runId)).toEqual([]);
    expect(await restarted.getEvaluationReport(artifact.runId)).toBeUndefined();
  });

  it("persists normalized metrics and reviewed failure rows without serializing evaluator exception text", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const rawFailure = "raw-evaluator-secret-sentinel";
    const evaluationReport = runEvaluationRegistry({
      id: "counter-evaluation",
      createdAt: "2026-07-22T13:01:00.000Z",
      context: {
        id: artifact.runId,
        status: artifact.status,
        initialState: artifact.initialState,
        finalState: artifact.finalState,
        agents: artifact.agents,
        trajectory: artifact.socialEpisode.steps,
        socialEpisode: artifact.socialEpisode
      },
      evaluators: [
        {
          id: "counter.value",
          label: "Counter value",
          version: "1",
          evaluate: () => ({
            evaluatorId: "counter.value",
            label: "Counter value",
            version: "1",
            metrics: [{
              id: "counter.final-value",
              label: "Final value",
              scope: "episode",
              value: artifact.finalState.value,
              source: "counter.value",
              evidenceRefs: [{ artifact: "state", description: "Canonical final counter state." }]
            }]
          })
        },
        {
          id: "counter.failing",
          label: "Failing evaluator",
          version: "1",
          evaluate: () => {
            throw new Error(rawFailure);
          }
        }
      ]
    });
    if (!evaluationReport.failures?.[0]) throw new Error("counter fixture did not record evaluator failure");
    const store = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });

    const entry = await store.put(artifact, { evaluationReport });
    expect(entry).toMatchObject({ metricCount: 1, failureCount: 1, checkpointCount: 0 });
    expect(await store.getMetrics(artifact.runId)).toEqual(evaluationReport.metrics);
    expect(await store.getEvaluationReport(artifact.runId)).toEqual(evaluationReport);
    expect(await store.getFailures(artifact.runId)).toEqual([
      expect.objectContaining({
        source: "evaluator",
        stage: "evaluate",
        code: "evaluator_exception",
        evaluatorId: "counter.failing",
        message: "Evaluator execution failed; no metrics or output were recorded."
      })
    ]);

    const episodeDirectory = path.join(root, "episodes", entry.directoryKey);
    const metricsText = await readFile(path.join(episodeDirectory, "metrics.jsonl"), "utf8");
    const failuresText = await readFile(path.join(episodeDirectory, "failures.jsonl"), "utf8");
    const evaluationText = await readFile(path.join(episodeDirectory, "evaluation-report.json"), "utf8");
    expect(metricsText).toContain("counter.final-value");
    expect(failuresText).not.toContain(rawFailure);
    expect(evaluationText).not.toContain(rawFailure);

    const restarted = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });
    expect(await restarted.getMetrics(artifact.runId)).toEqual(evaluationReport.metrics);
    expect(await restarted.getFailures(artifact.runId)).toHaveLength(1);
    expect(await restarted.getEvaluationReport(artifact.runId)).toEqual(evaluationReport);

    const forgedRoot = await temporaryStoreRoot();
    const forgedStore = await HarnessEpisodeArtifactStore.open({
      baseDirectory: forgedRoot,
      verifyArtifact: counterVerifier()
    });
    const forgedReport = structuredClone(evaluationReport);
    forgedReport.failures![0]!.message = rawFailure;
    await expect(forgedStore.put(artifact, { evaluationReport: forgedReport }))
      .rejects.toThrow(/unreviewed evaluator failure/i);
    expect(JSON.stringify(await forgedStore.list())).not.toContain(rawFailure);

    await writeFile(path.join(episodeDirectory, "metrics.jsonl"), `${metricsText.trim()} ${rawFailure}\n`, "utf8");
    await expect(restarted.get(artifact.runId)).rejects.toThrow(/canonical recovery validation/i);
  });

  it("distinguishes a zero-metric report from no report and binds the complete report across restart", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const report = runEvaluationRegistry({
      id: "counter-zero-metric-evaluation",
      createdAt: "2026-07-22T13:01:30.000Z",
      context: {
        id: artifact.runId,
        status: artifact.status,
        initialState: artifact.initialState,
        finalState: artifact.finalState,
        agents: artifact.agents,
        trajectory: artifact.socialEpisode.steps
      },
      evaluators: [{
        id: "counter.zero",
        label: "Counter zero output",
        version: "1",
        evaluate: () => ({
          evaluatorId: "counter.zero",
          label: "Counter zero output",
          version: "1",
          metrics: [],
          output: { checked: true, finalValue: artifact.finalState.value }
        })
      }]
    });
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    const entry = await store.put(artifact, { evaluationReport: report });
    expect(entry).toMatchObject({ metricCount: 0, evaluationReportId: report.id });
    const firstRead = await store.getEvaluationReport(artifact.runId);
    expect(firstRead).toEqual(report);
    firstRead!.outputs["counter.zero"] = { checked: false };
    expect(await store.getEvaluationReport(artifact.runId)).toEqual(report);

    const restarted = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    expect(await restarted.getEvaluationReport(artifact.runId)).toEqual(report);
    expect(await restarted.getMetrics(artifact.runId)).toEqual([]);

    const evaluationPath = path.join(root, "episodes", entry.directoryKey, "evaluation-report.json");
    const persisted = JSON.parse(await readFile(evaluationPath, "utf8"));
    persisted.report.outputs["counter.zero"].checked = false;
    await writeFile(evaluationPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await expect(restarted.getEvaluationReport(artifact.runId)).rejects.toThrow(/canonical recovery validation/i);
  });

  it("strongly verifies, persists, rehydrates, and recovers the checkpoint registry", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const checkpointVerifier = counterCheckpointVerifier();
    const store = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier(),
      verifyCheckpoint: checkpointVerifier
    });
    const episodeEntry = await store.put(artifact);
    const checkpointOne = buildCounterCheckpoint(artifact, "../../checkpoint-one", "2026-07-22T13:02:00.000Z");
    const checkpointTwo = buildCounterCheckpoint(artifact, "checkpoint-two", "2026-07-22T13:03:00.000Z");

    const firstEntry = await store.putCheckpoint(artifact.runId, checkpointOne);
    const secondEntry = await store.putCheckpoint(artifact.runId, checkpointTwo);
    expect(firstEntry.directoryKey).toMatch(/^[a-f0-9]{64}$/);
    expect(firstEntry.directoryKey).not.toContain("..");
    expect(await store.listCheckpoints(artifact.runId)).toEqual([firstEntry, secondEntry]);
    expect(await store.getCheckpoint(artifact.runId, checkpointOne.checkpointId)).toEqual(checkpointOne);
    expect((await store.list())[0]).toMatchObject({ checkpointCount: 2 });

    const restarted = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier(),
      verifyCheckpoint: checkpointVerifier
    });
    expect(await restarted.listCheckpoints(artifact.runId)).toEqual([firstEntry, secondEntry]);
    expect(await restarted.getCheckpoint(artifact.runId, checkpointTwo.checkpointId)).toEqual(checkpointTwo);

    const checkpointsDirectory = path.join(root, "episodes", episodeEntry.directoryKey, "checkpoints");
    const firstPath = path.join(checkpointsDirectory, firstEntry.directoryKey, "checkpoint.json");
    const tampered = JSON.parse(await readFile(firstPath, "utf8")) as CounterCheckpoint;
    tampered.state.value = 999;
    await writeFile(firstPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const secondPath = path.join(checkpointsDirectory, secondEntry.directoryKey, "checkpoint.json");
    const outsideFile = path.join(root, "outside-checkpoint.json");
    await writeFile(outsideFile, JSON.stringify(checkpointTwo), "utf8");
    await unlink(secondPath);
    await symlink(outsideFile, secondPath);

    await expect(restarted.getCheckpoint(artifact.runId, checkpointOne.checkpointId)).rejects.toThrow(/canonical recovery validation/i);
    await expect(restarted.getCheckpoint(artifact.runId, checkpointTwo.checkpointId)).rejects.toThrow(/canonical recovery validation/i);
    const recovered = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier(),
      verifyCheckpoint: checkpointVerifier
    });
    expect(await recovered.listCheckpoints(artifact.runId)).toEqual([]);
    expect((await recovered.list())[0]).toMatchObject({ checkpointCount: 0 });
  });

  it("requires an explicit checkpoint verifier and rejects forged checkpoints before publication", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const store = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });
    await store.put(artifact);
    const checkpoint = buildCounterCheckpoint(artifact, "counter-checkpoint", "2026-07-22T13:04:00.000Z");
    await expect(store.putCheckpoint(artifact.runId, checkpoint)).rejects.toThrow(/explicit canonical checkpoint verifier/i);
    expect(await store.listCheckpoints(artifact.runId)).toEqual([]);

    const rejecting = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier(),
      verifyCheckpoint: () => ({ ok: true, mismatches: ["forged durable state"] })
    });
    await expect(rejecting.putCheckpoint(artifact.runId, checkpoint)).rejects.toThrow(/verification rejected/i);
    expect(await rejecting.listCheckpoints(artifact.runId)).toEqual([]);
  });

  it("rejects a self-consistent checkpoint that is not the canonical parent episode prefix", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const store = await HarnessEpisodeArtifactStore.open<CounterArtifact, CounterCheckpoint>({
      baseDirectory: root,
      verifyArtifact: counterVerifier(),
      verifyCheckpoint: counterCheckpointVerifier()
    });
    await store.put(artifact);
    const checkpoint = buildCounterCheckpoint(artifact, "foreign-prefix", "2026-07-22T13:04:30.000Z");
    checkpoint.executionPrefix.steps[0]!.traceId = "foreign-trace";
    checkpoint.source.executionPrefixHash = hashStableState(checkpoint.executionPrefix);

    await expect(store.putCheckpoint(artifact.runId, checkpoint)).rejects.toThrow(/not a canonical prefix/i);
    expect(await store.listCheckpoints(artifact.runId)).toEqual([]);
  });

  it("rejects verifier failures before publishing a directory or index entry", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const store = await HarnessEpisodeArtifactStore.open<CounterArtifact>({
      baseDirectory: root,
      verifyArtifact: () => ({ ok: false, mismatches: ["semantic forgery"] })
    });

    await expect(store.put(artifact)).rejects.toThrow(/verification rejected/i);
    expect(await store.list()).toEqual([]);
  });

  it("fails closed on tampered content and excludes it during restart recovery", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const verifier = counterVerifier();
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: verifier });
    const entry = await store.put(artifact);
    const artifactPath = path.join(root, "episodes", entry.directoryKey, "artifact.json");
    const tampered = JSON.parse(await readFile(artifactPath, "utf8")) as CounterArtifact;
    tampered.finalState.value = 999;
    await writeFile(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await expect(store.get(artifact.runId)).rejects.toThrow(/canonical recovery validation/i);
    const restarted = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: verifier });
    expect(await restarted.list()).toEqual([]);
  });

  it("makes exact artifact publication retry idempotent and rejects immutable drift", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const evaluationReport = runEvaluationRegistry({
      id: "idempotent-publication",
      createdAt: "2026-07-22T13:02:00.000Z",
      context: {
        id: artifact.runId,
        status: artifact.status,
        initialState: artifact.initialState,
        finalState: artifact.finalState,
        agents: artifact.agents,
        trajectory: artifact.socialEpisode.steps
      },
      evaluators: [{
        id: "idempotent.counter",
        label: "Idempotent counter",
        version: "1",
        evaluate: () => ({
          evaluatorId: "idempotent.counter",
          label: "Idempotent counter",
          version: "1",
          metrics: [{
            id: "idempotent.value",
            label: "Idempotent value",
            scope: "episode",
            value: artifact.finalState.value,
            source: "idempotent.counter"
          }]
        })
      }]
    });
    const store = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });

    const first = await store.put(artifact, { evaluationReport });
    expect(await store.put(structuredClone(artifact), {
      evaluationReport: structuredClone(evaluationReport)
    })).toEqual(first);

    const restarted = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });
    expect(await restarted.put(structuredClone(artifact), {
      evaluationReport: structuredClone(evaluationReport)
    })).toEqual(first);

    const driftedReport = structuredClone(evaluationReport);
    driftedReport.metrics[0]!.label = "Changed after publication";
    await expect(restarted.put(structuredClone(artifact), { evaluationReport: driftedReport }))
      .rejects.toThrow(/different immutable content/i);
    await expect(restarted.put(structuredClone(artifact)))
      .rejects.toThrow(/different immutable content/i);
  });

  it("converges concurrent exact publishers onto one canonical episode directory", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const firstStore = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });
    const secondStore = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });

    const [first, second] = await Promise.all([
      firstStore.put(structuredClone(artifact)),
      secondStore.put(structuredClone(artifact))
    ]);

    expect(second).toEqual(first);
    const reopened = await HarnessEpisodeArtifactStore.open({
      baseDirectory: root,
      verifyArtifact: counterVerifier()
    });
    expect(await reopened.list()).toEqual([first]);
  });

  it("binds recovery directories to identity hashes and rejects unknown failure fields", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    const report = runEvaluationRegistry({
      id: "failure-row-audit",
      context: {
        id: artifact.runId,
        status: artifact.status,
        initialState: artifact.initialState,
        finalState: artifact.finalState,
        agents: artifact.agents,
        trajectory: artifact.socialEpisode.steps
      },
      evaluators: [{
        id: "failing-audit",
        label: "Failing audit",
        version: "1",
        evaluate: () => { throw new Error("unpersisted sentinel"); }
      }]
    });
    const entry = await store.put(artifact, { evaluationReport: report });
    const directory = path.join(root, "episodes", entry.directoryKey);
    const failuresPath = path.join(directory, "failures.jsonl");
    const [failure] = (await readFile(failuresPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    failure.rawProviderError = "must-never-recover";
    const failuresText = `${JSON.stringify(failure)}\n`;
    await writeFile(failuresPath, failuresText, "utf8");
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.failuresSha256 = rawSha256(failuresText);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const rejected = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: counterVerifier() });
    expect(await rejected.list()).toEqual([]);

    const secondRoot = await temporaryStoreRoot();
    const secondStore = await HarnessEpisodeArtifactStore.open({ baseDirectory: secondRoot, verifyArtifact: counterVerifier() });
    const secondEntry = await secondStore.put(artifact);
    const wrongKey = "f".repeat(64) === secondEntry.directoryKey ? "e".repeat(64) : "f".repeat(64);
    const oldDirectory = path.join(secondRoot, "episodes", secondEntry.directoryKey);
    const movedDirectory = path.join(secondRoot, "episodes", wrongKey);
    await rename(oldDirectory, movedDirectory);
    const movedManifestPath = path.join(movedDirectory, "manifest.json");
    const movedManifest = JSON.parse(await readFile(movedManifestPath, "utf8"));
    movedManifest.directoryKey = wrongKey;
    await writeFile(movedManifestPath, `${JSON.stringify(movedManifest, null, 2)}\n`, "utf8");
    const wrongKeyRecovery = await HarnessEpisodeArtifactStore.open({
      baseDirectory: secondRoot,
      verifyArtifact: counterVerifier()
    });
    expect(await wrongKeyRecovery.list()).toEqual([]);
  });

  it("rejects symlinked canonical files and never interprets a run id as a host path", async () => {
    const root = await temporaryStoreRoot();
    const artifact = await buildCounterArtifact();
    artifact.runId = "../../outside/episode";
    artifact.socialEpisode.id = artifact.runId;
    const verifier = counterVerifier();
    const store = await HarnessEpisodeArtifactStore.open({ baseDirectory: root, verifyArtifact: verifier });
    const entry = await store.put(artifact);
    expect(entry.directoryKey).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.directoryKey).not.toContain("..");

    const episodeDirectory = path.join(root, "episodes", entry.directoryKey);
    const artifactPath = path.join(episodeDirectory, "artifact.json");
    const outsideFile = path.join(root, "outside.json");
    await writeFile(outsideFile, JSON.stringify(artifact), "utf8");
    await unlink(artifactPath);
    await symlink(outsideFile, artifactPath);
    await expect(store.get(artifact.runId)).rejects.toThrow(/canonical recovery validation/i);
  });
});

async function temporaryStoreRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "generic-episode-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function buildCounterArtifact(onDecision: () => void = () => undefined): Promise<CounterArtifact> {
  const environment = new CounterEnvironment();
  const actor: SocialActor<CounterObservation, CounterPending, CounterCommand> = {
    id: "counter-a",
    profile: { id: "counter-profile", model: "deterministic", policyId: "counter.policy" },
    observe() {},
    decide(pending) {
      onDecision();
      return { actorId: "counter-a", kind: "increment", command: { actorId: pending.actorId, amount: 1 } };
    }
  };
  const socialEpisode = await runHarnessEpisode<
    CounterState,
    CounterObservation,
    CounterPending,
    CounterCommand,
    CounterAgentState
  >({
    id: "counter-ledger-run",
    domainAdapter: counterAdapter,
    environment,
    actors: [actor],
    channels: [],
    schedulerMode: "aec",
    hashState: hashStableState,
    hashMessages: hashStableState,
    captureAgentSnapshots: () => [{ actorId: "counter-a", committedValue: environment.snapshot().value }]
  });
  const agents = socialEpisode.steps.at(-1)?.actorSnapshotsAfterStep as CounterAgentState[] | undefined;
  if (!agents) throw new Error("counter fixture did not capture durable actor state");
  return {
    artifactVersion: "counter-ledger.episode.v1",
    kind: "counter-ledger-episode",
    runId: socialEpisode.id,
    createdAt: "2026-07-22T13:00:00.000Z",
    status: socialEpisode.status,
    initialState: socialEpisode.initialState,
    finalState: socialEpisode.finalState,
    socialEpisode,
    agents
  };
}

function counterVerifier() {
  return (artifact: CounterArtifact) =>
    verifyHarnessEpisodeArtifact({
      artifact,
      runtime: {
        domainAdapter: counterAdapter,
        createEnvironment: (initialState) => new CounterEnvironment(initialState),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep(step, context) {
          const pending = context.pendingActions[0];
          return pending?.actorId === step.actorId && step.pendingAction.actorId === pending.actorId
            ? []
            : ["recorded pending action does not match replay authority"];
        },
        recordedAgentState: {
          mode: "validate",
          validator(input) {
            const actor = input.recordedAgents.find((candidate) => candidate.actorId === "counter-a");
            return actor?.committedValue === input.stateAfter.value
              ? []
              : ["durable counter state does not match committed environment state"];
          }
        }
      }
    });
}

function buildCounterCheckpoint(
  artifact: CounterArtifact,
  checkpointId: string,
  createdAt: string
): CounterCheckpoint {
  return buildHarnessCheckpointFromEpisode({
    artifactVersion: "counter-ledger.checkpoint.v1",
    kind: "counter-ledger-checkpoint",
    checkpointId,
    createdAt,
    sourceArtifactVersion: artifact.artifactVersion,
    runId: artifact.runId,
    sourceStatus: artifact.status,
    episode: artifact.socialEpisode,
    agents: artifact.agents
  });
}

function counterCheckpointVerifier() {
  return (checkpoint: CounterCheckpoint) => {
    const mismatches = [...validateHarnessCheckpointEnvelope(checkpoint)];
    const replay = replaySocialEpisode<CounterState, CounterObservation, CounterPending, CounterCommand, CounterAgentState>({
      episode: checkpoint.executionPrefix,
      environment: new CounterEnvironment(checkpoint.executionPrefix.initialState),
      hashState: hashStableState,
      hashMessages: hashStableState,
      domainAdapter: counterAdapter,
      validateRecordedStep(step, context) {
        const pending = context.pendingActions[0];
        return pending?.actorId === step.actorId && step.pendingAction.actorId === pending.actorId
          ? []
          : ["recorded pending action does not match replay authority"];
      },
      validateRecordedAgentState(input) {
        const actor = input.recordedAgents.find((candidate) => candidate.actorId === "counter-a");
        return actor?.committedValue === input.stateAfter.value
          ? []
          : ["durable counter state does not match committed environment state"];
      }
    });
    mismatches.push(
      ...validateHarnessCheckpointReplay(checkpoint, () => ({
        mismatches: replay.mismatches,
        finalHash: replay.finalHash,
        messagesHash: replay.messagesHash
      }))
    );
    const actor = checkpoint.agents.find((candidate) => candidate.actorId === "counter-a");
    if (actor?.committedValue !== checkpoint.state.value) {
      mismatches.push("checkpoint durable actor state does not match checkpoint state");
    }
    return { ok: mismatches.length === 0, mismatches };
  };
}

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
