import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";
import {
  buildHarnessCheckpointAtPrefix as buildGenericHarnessCheckpointAtPrefix,
  HARNESS_EPISODE_PROJECTION_VERSION,
  isSafeHarnessCheckpointBoundary,
  validateHarnessCheckpointEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope,
  type HarnessEpisodeProjectionEnvelope
} from "../src/harness/episodeArtifacts";
import {
  HarnessEpisodeArtifactStore,
  deriveHarnessEpisodeArtifactSha256
} from "../src/harness/episodeArtifactStore";
import {
  runGenericExperiment,
  type GenericExperimentArtifactStore,
  type GenericExperimentRunStore
} from "../src/harness/experimentOrchestrator";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HarnessExperimentRunStore,
  type HarnessExperimentRunRecordV2
} from "../src/harness/experimentRunStore";
import {
  createGenericExperimentProvenance,
  validateGenericExperimentExecutionEvidence,
  type GenericExperimentSpecV1
} from "../src/harness/experimentSpec";
import type { HarnessEvaluator } from "../src/harness/evaluation";
import { hashStableJsonValue, hashStableState } from "../src/harness/hash";
import { runHarnessEpisode } from "../src/harness/runner";
import {
  isSocialStepCommitted,
  validateSocialParallelBatchLayout,
  type SocialActor,
  type SocialAgentProfile,
  type SocialEnvironment,
  type SocialEpisodeArtifact
} from "../src/harness/social";
import { verifyHarnessEpisodeArtifact } from "../src/harness/socialReplay";

interface State {
  value: number;
  done: boolean;
}

interface Pending {
  actorId: string;
  kind: "increment";
}

interface Observation {
  actorId: string;
  value: number;
}

interface Command {
  actorId: string;
  amount: 1;
}

type Artifact = HarnessEpisodeArtifactEnvelope<State, Observation, Pending, Command, never>;
type Checkpoint = HarnessCheckpointEnvelope<State, never, Observation, Pending, Command>;

const adapterManifest: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: "counter-orchestration",
  adapterId: "counter-orchestration.social",
  adapterVersion: "1",
  semanticHash: hashStableState({ adapter: "counter-orchestration", version: 1 }),
  components: [
    { kind: "agent_state_schema", id: "counter.none", version: "1", semanticHash: hashStableState({ durable: false }) },
    { kind: "command_codec", id: "counter.command", version: "1", semanticHash: hashStableState({ amount: 1 }) },
    { kind: "environment", id: "counter.environment", version: "1", semanticHash: hashStableState({ terminalValue: 1 }) },
    { kind: "observation_projection", id: "counter.observation", version: "1", semanticHash: hashStableState({ private: false }) },
    { kind: "scheduler", id: "counter.scheduler", version: "1", semanticHash: hashStableState({ mode: "aec" }) }
  ]
};

const counterEvaluator: HarnessEvaluator<
  State,
  undefined,
  SocialEpisodeArtifact<State, Observation, Pending, Command>,
  unknown,
  never,
  never
> = {
  id: "counter.value.v1",
  label: "Counter value",
  version: "1",
  evaluate(context) {
    return {
      evaluatorId: "counter.value.v1",
      label: "Counter value",
      version: "1",
      metrics: [
        {
          id: "episode.counter_value",
          label: "Counter value",
          source: "counter.value.v1",
          scope: "episode",
          value: context.finalState.value,
          weight: 1,
          evidenceRefs: []
        }
      ]
    };
  }
};

class Environment implements SocialEnvironment<State, Observation, Pending, Command> {
  private state: State;

  constructor(initial: State = { value: 0, done: false }) {
    this.state = structuredClone(initial);
  }

  snapshot(): State {
    return structuredClone(this.state);
  }

  pendingActions(): Pending[] {
    return this.state.done ? [] : [{ actorId: "a", kind: "increment" }];
  }

  observe(): Observation {
    return { actorId: "a", value: this.state.value };
  }

  validateAction(command: Command, pending: Pending) {
    return { valid: command.actorId === pending.actorId && command.amount === 1 };
  }

  step(command: Command): State {
    if (this.state.done || command.amount !== 1) throw new Error("invalid counter command");
    this.state = { value: this.state.value + 1, done: true };
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

class ParallelEnvironment implements SocialEnvironment<State, Observation, Pending, Command> {
  private state: State = { value: 0, done: false };

  snapshot(): State {
    return structuredClone(this.state);
  }

  pendingActions(): Pending[] {
    return this.state.done
      ? []
      : [
          { actorId: "a", kind: "increment" },
          { actorId: "b", kind: "increment" }
        ];
  }

  observe(actorId: string): Observation {
    return { actorId, value: this.state.value };
  }

  validateAction(command: Command, pending: Pending) {
    return { valid: command.actorId === pending.actorId && command.amount === 1 };
  }

  step(): State {
    throw new Error("parallel counter requires stepBatch");
  }

  stepBatch(commandsByAgent: Record<string, Command>): State {
    if (this.state.done || Object.keys(commandsByAgent).sort().join(",") !== "a,b") {
      throw new Error("invalid parallel counter batch");
    }
    this.state = { value: 2, done: true };
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generic normalized experiment orchestration", () => {
  it("runs, evaluates, persists, and materializes a non-Werewolf tournament through existing harness primitives", async () => {
    const root = await temporaryRoot();
    let decisions = 0;
    let preparations = 0;
    const store = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact: verifyArtifact
    });
    const persistedRunStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "experiment-runs"),
      episodeStore: store,
      now: () => "2026-07-22T14:00:00.000Z"
    });
    const lifecycle: string[] = [];
    const artifactStore: GenericExperimentArtifactStore<Artifact> = {
      async put(artifact, options) {
        lifecycle.push(`put:${artifact.runId.endsWith(":g1") ? 0 : 1}`);
        return store.put(artifact, options);
      },
      get: (runId) => store.get(runId),
      getEvaluationReport: (runId) => store.getEvaluationReport(runId)
    };
    const runStore: GenericExperimentRunStore<Artifact> = {
      async beginOrResume(input) {
        lifecycle.push("begin");
        return persistedRunStore.beginOrResume(input);
      },
      async startEpisode(input) {
        lifecycle.push(`start:${input.index}`);
        return persistedRunStore.startEpisode(input);
      },
      async stageEpisode(input) {
        lifecycle.push(`stage:${input.episode.index}`);
        return persistedRunStore.stageEpisode(input);
      },
      recoverCurrentEpisode: (runSetId) => persistedRunStore.recoverCurrentEpisode(runSetId),
      async recordEpisode(input) {
        lifecycle.push(`record:${input.episode.index}`);
        return persistedRunStore.recordEpisode(input);
      },
      async finalize(runSet) {
        lifecycle.push("finalize");
        return persistedRunStore.finalize(runSet);
      }
    };
    const result = await runGenericExperiment({
      spec: experimentSpec(),
      artifactStore,
      runStore,
      now: () => "2026-07-22T14:00:00.000Z",
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          lifecycle.push(`prepare:${context.index}`);
          preparations += 1;
          return { runId: `${context.spec.id}:${context.seed}`, context };
        },
        async runEpisode(prepared, context) {
          return counterEpisode(prepared.runId, () => {
            decisions += 1;
          }, {
            maxTransitions: context.spec.maxTransitions,
            decisionTimeoutMs: context.spec.timeoutPolicy.decisionTimeoutMs
          });
        },
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode(episode) {
          return artifactFromEpisode(episode);
        },
        evaluation: {
          evaluators: [counterEvaluator],
          contextForEpisode(episode, artifact) {
            return {
              id: artifact.runId,
              status: artifact.status,
              initialState: artifact.initialState,
              finalState: artifact.finalState,
              agents: [],
              trajectory: [],
              socialEpisode: episode
            };
          }
        }
      }
    });

    expect(result.normalizedSpec).toMatchObject({
      version: "harness.experiment.v1",
      domainId: "counter-orchestration",
      episodeCount: 2
    });
    expect(result.specHash).toBe(result.experiment.specHash);
    expect(result.experiment.spec).toEqual(result.normalizedSpec);
    expect(result.publication).toBeUndefined();
    expect(result.tournament).toMatchObject({
      gamesRequested: 2,
      gamesCompleted: 2,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesUnstarted: 0
    });
    expect(result.tournament.episodes.map((episode) => episode.seed)).toEqual([
      "counter-orchestration-seed:g1",
      "counter-orchestration-seed:g2"
    ]);
    expect(result.runSet.episodes.map((episode) => episode.evaluationReport?.metrics[0]?.value)).toEqual([1, 1]);
    expect(result.runSet.episodes.every((episode) => episode.artifact !== undefined)).toBe(true);
    expect(result.runSet.episodes.every((episode) => episode.artifact?.experiment?.specHash === result.specHash)).toBe(true);
    expect(result.runSet.episodes.every((episode) =>
      episode.artifact?.executionAttestation?.schemaVersion === "harness.experiment-execution-attestation.v1" &&
      episode.artifact.executionAttestation.maxTransitions === 2 &&
      episode.artifact.executionAttestation.decisionTimeoutMs === 5_000 &&
      episode.artifact.executionAttestation.actors[0]?.actorId === "a" &&
      episode.artifact.executionAttestation.actors[0]?.profile.id === "counter-profile"
    )).toBe(true);
    expect((await store.list()).map((entry) => entry.runId)).toEqual([
      "counter-experiment:counter-orchestration-seed:g1",
      "counter-experiment:counter-orchestration-seed:g2"
    ]);
    expect(preparations).toBe(2);
    expect(decisions).toBe(2);
    expect(lifecycle).toEqual([
      "begin",
      "start:0",
      "prepare:0",
      "stage:0",
      "put:0",
      "record:0",
      "start:1",
      "prepare:1",
      "stage:1",
      "put:1",
      "record:1",
      "finalize"
    ]);

    const restarted = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact
    });
    expect(await restarted.list()).toHaveLength(2);
    expect(await restarted.getMetrics("counter-experiment:counter-orchestration-seed:g1")).toMatchObject([
      { id: "episode.counter_value", value: 1 }
    ]);
    expect(await restarted.getFailures("counter-experiment:counter-orchestration-seed:g1")).toEqual([]);
    expect(await restarted.getEvaluationReport("counter-experiment:counter-orchestration-seed:g1"))
      .toEqual(result.runSet.episodes[0]?.evaluationReport);
    const restartedRunStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "experiment-runs"),
      episodeStore: restarted
    });
    expect(await restartedRunStore.get("counter-experiment")).toMatchObject({
      state: "finalized",
      gamesRequested: 2,
      gamesCompleted: 2,
      gamesUnstarted: 0,
      episodes: [
        {
          index: 0,
          runId: "counter-experiment:counter-orchestration-seed:g1",
          metricCount: 1,
          evaluationReportId: "counter-experiment:g1:evaluation",
          evaluationReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        {
          index: 1,
          runId: "counter-experiment:counter-orchestration-seed:g2",
          metricCount: 1,
          evaluationReportId: "counter-experiment:g2:evaluation",
          evaluationReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      ]
    });
    expect(decisions).toBe(2);

    const resumed = await runGenericExperiment({
      spec: experimentSpec(),
      artifactStore: {
        async put() {
          throw new Error("finalized resume must not publish");
        },
        get: (runId) => restarted.get(runId),
        getEvaluationReport: (runId) => restarted.getEvaluationReport(runId)
      },
      runStore: restartedRunStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode() {
          throw new Error("finalized resume must not prepare");
        },
        runEpisode() {
          throw new Error("finalized resume must not execute");
        },
        lifecycleOf() {
          throw new Error("finalized resume must not inspect domain lifecycle");
        },
        artifactForEpisode() {
          throw new Error("finalized resume must not materialize");
        }
      }
    });
    expect(resumed.runSet).toEqual(result.runSet);
    expect(decisions).toBe(2);

    await expect(runGenericExperiment({
      spec: experimentSpec(),
      artifactStore: {
        put: (artifact, options) => restarted.put(artifact, options),
        async get(runId) {
          const artifact = await restarted.get(runId);
          if (artifact) artifact.createdAt = "2026-07-22T14:00:01.000Z";
          return artifact;
        },
        getEvaluationReport: (runId) => restarted.getEvaluationReport(runId)
      },
      runStore: restartedRunStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode() { throw new Error("tampered prefix must not prepare"); },
        runEpisode() { throw new Error("tampered prefix must not execute"); },
        lifecycleOf() { throw new Error("tampered prefix must not inspect lifecycle"); },
        artifactForEpisode() { throw new Error("tampered prefix must not materialize"); }
      }
    })).rejects.toThrow(/drifted from durable experiment membership/i);
    expect(decisions).toBe(2);
  });

  it("adopts a staged canonical episode after restart and executes only the remaining suffix", async () => {
    const root = await temporaryRoot();
    const episodeStore = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact
    });
    const firstRunStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "experiment-runs"),
      episodeStore
    });
    let decisions = 0;
    const adapter = {
      domainId: "counter-orchestration",
      prepareEpisode(context: Parameters<NonNullable<Parameters<typeof runGenericExperiment>[0]>["adapter"]["prepareEpisode"]>[0]) {
        return { runId: `${context.spec.id}:${context.seed}` };
      },
      runEpisode(prepared: { runId: string }, context: Parameters<NonNullable<Parameters<typeof runGenericExperiment>[0]>["adapter"]["prepareEpisode"]>[0]) {
        return counterEpisode(prepared.runId, () => { decisions += 1; }, {
          maxTransitions: context.spec.maxTransitions,
          decisionTimeoutMs: context.spec.timeoutPolicy.decisionTimeoutMs
        });
      },
      lifecycleOf: (episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) => episode.status,
      artifactForEpisode: (episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) => artifactFromEpisode(episode)
    };
    let interrupted = false;
    await expect(runGenericExperiment({
      spec: { ...experimentSpec(), evaluatorIds: [] },
      artifactStore: episodeStore,
      runStore: {
        beginOrResume: (input) => firstRunStore.beginOrResume(input),
        startEpisode: (input) => firstRunStore.startEpisode(input),
        stageEpisode: (input) => firstRunStore.stageEpisode(input),
        recoverCurrentEpisode: (runSetId) => firstRunStore.recoverCurrentEpisode(runSetId),
        async recordEpisode(input) {
          if (!interrupted && input.episode.index === 0) {
            interrupted = true;
            throw new Error("simulated process boundary after canonical publication");
          }
          return firstRunStore.recordEpisode(input);
        },
        finalize: (runSet) => firstRunStore.finalize(runSet)
      },
      adapter
    })).rejects.toThrow(/simulated process boundary/i);
    expect(decisions).toBe(1);
    expect(await episodeStore.list()).toHaveLength(1);

    const restartedEpisodeStore = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact
    });
    const restartedRunStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "experiment-runs"),
      episodeStore: restartedEpisodeStore
    });
    const resumed = await runGenericExperiment({
      spec: { ...experimentSpec(), evaluatorIds: [] },
      artifactStore: restartedEpisodeStore,
      runStore: restartedRunStore,
      adapter
    });
    expect(decisions).toBe(2);
    expect(resumed.tournament.episodes.map((episode) => episode.status)).toEqual(["completed", "completed"]);
    expect(resumed.tournament.episodes.map((episode) => episode.seed)).toEqual([
      "counter-orchestration-seed:g1",
      "counter-orchestration-seed:g2"
    ]);
    expect(await restartedEpisodeStore.list()).toHaveLength(2);
  });

  it("binds control-plane provenance and refuses to overwrite a contradictory adapter claim", async () => {
    let puts = 0;
    const socialEpisode = await counterEpisode("counter-mismatched-provenance", () => undefined);
    const artifact = artifactFromEpisode(socialEpisode);
    artifact.experiment = createGenericExperimentProvenance({
      ...experimentSpec(),
      seed: "different-seed",
      episodeCount: 1,
      evaluatorIds: []
    });

    const result = await runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        continueOnError: false
      },
      artifactStore: {
        ...memoryArtifactStore<Artifact>(),
        async put() {
          puts += 1;
        }
      },
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: () => ({}),
        runEpisode: () => socialEpisode,
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: () => artifact
      }
    });

    expect(result.tournament).toMatchObject({ gamesCompleted: 0, gamesFailed: 1, gamesUnstarted: 0 });
    expect(result.runSet.episodes[0]).toMatchObject({ status: "failed" });
    expect(result.runSet.episodes[0]?.artifact).toBeUndefined();
    expect(puts).toBe(0);
  });

  it("fails closed on canonical artifact persistence errors even when domain failures may continue", async () => {
    const lifecycle: string[] = [];
    const socialEpisode = await counterEpisode(
      "counter-experiment:counter-orchestration-seed:g1",
      () => undefined,
      { maxTransitions: 2, decisionTimeoutMs: 5_000 }
    );

    await expect(runGenericExperiment({
      spec: { ...experimentSpec(), evaluatorIds: [], continueOnError: true },
      artifactStore: {
        ...memoryArtifactStore<Artifact>(),
        async put() {
          lifecycle.push("artifact-put");
          throw new Error("canonical artifact storage unavailable");
        }
      },
      runStore: {
        ...memoryRunStore<Artifact>(),
        async beginOrResume(input) {
          lifecycle.push("begin");
          return memoryRunStore<Artifact>().beginOrResume(input);
        },
        async startEpisode() {
          lifecycle.push("start");
        },
        async stageEpisode() {
          lifecycle.push("stage");
        },
        async recordEpisode() {
          lifecycle.push("record");
        },
        async finalize() {
          lifecycle.push("finalize");
        }
      },
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          lifecycle.push(`prepare:${context.index}`);
          return {};
        },
        runEpisode: () => socialEpisode,
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode)
      }
    })).rejects.toThrow(/canonical artifact storage unavailable/i);

    expect(lifecycle).toEqual(["begin", "start", "prepare:0", "stage", "artifact-put"]);
  });

  it("stops scheduling when durable episode membership cannot be recorded", async () => {
    const lifecycle: string[] = [];
    const socialEpisode = await counterEpisode(
      "counter-experiment:counter-orchestration-seed:g1",
      () => undefined,
      { maxTransitions: 2, decisionTimeoutMs: 5_000 }
    );

    await expect(runGenericExperiment({
      spec: { ...experimentSpec(), evaluatorIds: [], continueOnError: true },
      artifactStore: {
        ...memoryArtifactStore<Artifact>(),
        async put() {
          lifecycle.push("artifact-put");
        }
      },
      runStore: {
        ...memoryRunStore<Artifact>(),
        async beginOrResume(input) {
          lifecycle.push("begin");
          return memoryRunStore<Artifact>().beginOrResume(input);
        },
        async startEpisode() {
          lifecycle.push("start");
        },
        async stageEpisode() {
          lifecycle.push("stage");
        },
        async recordEpisode() {
          lifecycle.push("record");
          throw new Error("durable episode membership unavailable");
        },
        async finalize() {
          lifecycle.push("finalize");
        }
      },
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          lifecycle.push(`prepare:${context.index}`);
          return {};
        },
        runEpisode: () => socialEpisode,
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode)
      }
    })).rejects.toThrow(/durable episode membership unavailable/i);

    expect(lifecycle).toEqual(["begin", "start", "prepare:0", "stage", "artifact-put", "record"]);
  });

  it("isolates callback mutations and enforces an in-flight experiment deadline", async () => {
    const socialEpisode = await counterEpisode("counter-experiment:counter-orchestration-seed:g1", () => undefined);
    const mutationResult = await runGenericExperiment({
      spec: { ...experimentSpec(), episodeCount: 1, evaluatorIds: [] },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          context.spec.seed = "adapter-mutated-seed";
          context.experiment.spec.seed = "adapter-mutated-experiment";
          return {};
        },
        runEpisode: () => socialEpisode,
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode)
      }
    });
    expect(mutationResult.normalizedSpec.seed).toBe("counter-orchestration-seed");
    expect(mutationResult.experiment.spec.seed).toBe("counter-orchestration-seed");
    expect(mutationResult.runSet.episodes[0]?.artifact?.experiment).toEqual(mutationResult.experiment);

    let artifactCalls = 0;
    const startedAt = Date.now();
    const timeoutResult = await runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        continueOnError: false,
        timeoutPolicy: { id: "counter.timeout", version: "1", runTimeoutMs: 25 }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: () => ({}),
        runEpisode: () => new Promise<SocialEpisodeArtifact<State, Observation, Pending, Command>>(() => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: async (): Promise<Artifact> => {
          artifactCalls += 1;
          throw new Error("late artifact must not be requested");
        }
      }
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(timeoutResult.tournament).toMatchObject({ gamesFailed: 1, gamesUnstarted: 0 });
    expect(timeoutResult.runSet.episodes[0]).toMatchObject({ status: "failed" });
    expect(artifactCalls).toBe(0);
  });

  it("rejects evaluation context that is not bound to the canonical episode", async () => {
    const socialEpisode = await counterEpisode("counter-experiment:counter-orchestration-seed:g1", () => undefined);
    let puts = 0;
    const result = await runGenericExperiment({
      spec: { ...experimentSpec(), episodeCount: 1, continueOnError: false },
      artifactStore: {
        ...memoryArtifactStore<Artifact>(),
        put: async () => { puts += 1; }
      },
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: () => ({}),
        runEpisode: () => socialEpisode,
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        evaluation: {
          evaluators: [counterEvaluator],
          contextForEpisode(episode, artifact) {
            return {
              id: "different-run",
              status: artifact.status,
              initialState: artifact.initialState,
              finalState: artifact.finalState,
              agents: [],
              trajectory: [],
              socialEpisode: episode
            };
          }
        }
      }
    });
    expect(result.tournament.gamesFailed).toBe(1);
    expect(puts).toBe(0);
  });

  it("fails closed before persistence when an adapter ignores spec-owned execution composition", async () => {
    const baseSpec: GenericExperimentSpecV1 = {
      ...experimentSpec(),
      episodeCount: 1,
      evaluatorIds: [],
      continueOnError: false
    };
    const cases: Array<{
      name: string;
      spec?: GenericExperimentSpecV1;
      episode: SocialEpisodeArtifact<State, Observation, Pending, Command>;
      mutateArtifact?: (artifact: Artifact) => void;
    }> = [
      {
        name: "ignored maxTransitions",
        episode: await counterEpisode("ignored-max-transitions", () => undefined, {
          maxTransitions: undefined,
          decisionTimeoutMs: 5_000
        })
      },
      {
        name: "ignored decisionTimeoutMs",
        episode: await counterEpisode("ignored-decision-timeout", () => undefined, {
          maxTransitions: 2,
          decisionTimeoutMs: undefined
        })
      },
      {
        name: "unknown runtime profile",
        episode: await counterEpisode("unknown-runtime-profile", () => undefined, undefined, {
          id: "shadow-profile",
          version: "1",
          model: "deterministic",
          policyId: "counter.policy"
        })
      },
      {
        name: "profile version drift",
        episode: await counterEpisode("profile-version-drift", () => undefined, undefined, {
          id: "counter-profile",
          version: "2",
          model: "deterministic",
          policyId: "counter.policy"
        })
      },
      {
        name: "policy drift",
        episode: await counterEpisode("policy-drift", () => undefined, undefined, {
          id: "counter-profile",
          version: "1",
          model: "deterministic",
          policyId: "counter.other-policy"
        })
      },
      {
        name: "explicit model assignment drift",
        spec: {
          ...baseSpec,
          modelAssignments: [{ profileId: "counter-profile", modelId: "expected-model" }],
          providerPolicy: { id: "counter.provider", version: "1", stream: true }
        },
        episode: await counterEpisode("model-assignment-drift", () => undefined, undefined, {
          id: "counter-profile",
          version: "1",
          model: "wrong-model",
          policyId: "counter.policy"
        })
      },
      {
        name: "runtime actor roster split",
        episode: await counterEpisode("runtime-actor-roster-split", () => undefined),
        mutateArtifact(artifact) {
          artifact.socialEpisode.runtimeActors![0]!.actorId = "different-actor";
        }
      },
      {
        name: "contradictory pre-bound attestation",
        episode: await counterEpisode("contradictory-pre-bound-attestation", () => undefined),
        mutateArtifact(artifact) {
          artifact.executionAttestation = {
            schemaVersion: "harness.experiment-execution-attestation.v1",
            specHash: "forged-spec-hash",
            schedulerMode: "aec",
            maxTransitions: 2,
            decisionTimeoutMs: 5_000,
            actors: []
          };
        }
      }
    ];

    for (const testCase of cases) {
      let puts = 0;
      const result = await runGenericExperiment({
        spec: testCase.spec ?? baseSpec,
        artifactStore: {
          ...memoryArtifactStore<Artifact>(),
          async put() { puts += 1; }
        },
        runStore: memoryRunStore(),
        adapter: {
          domainId: "counter-orchestration",
          prepareEpisode: () => ({}),
          runEpisode: () => testCase.episode,
          lifecycleOf: (episode) => episode.status,
          artifactForEpisode(episode) {
            const artifact = artifactFromEpisode(episode);
            testCase.mutateArtifact?.(artifact);
            return artifact;
          }
        }
      });

      expect(result.tournament, testCase.name).toMatchObject({
        gamesCompleted: 0,
        gamesFailed: 1,
        gamesUnstarted: 0
      });
      expect(result.runSet.episodes[0], testCase.name).toMatchObject({ status: "failed" });
      expect(result.runSet.episodes[0]?.artifact, testCase.name).toBeUndefined();
      expect(puts, testCase.name).toBe(0);
    }
  });

  it("retries only domain-classified prepare/run throws and persists the accepted v3 attempt ledger", async () => {
    const root = await temporaryRoot();
    const artifactStore = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "retry-episodes"),
      verifyArtifact
    });
    const runStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "retry-runs"),
      episodeStore: artifactStore
    });
    const classifications: Array<{ stage: string; ordinal: number }> = [];
    let prepareCalls = 0;
    let runCalls = 0;
    const spec = {
      ...experimentSpec(),
      episodeCount: 1,
      retryPolicy: { id: "counter.retry", version: "2", maxAttempts: 3, backoffMs: 0 }
    };
    const result = await runGenericExperiment({
      spec,
      runSetId: "classified-retry",
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          prepareCalls += 1;
          if (prepareCalls === 1) throw new Error("injected prepare failure that must not be persisted");
          return { runId: `${context.spec.id}:${context.seed}` };
        },
        runEpisode(prepared) {
          runCalls += 1;
          if (runCalls === 1) throw new Error("injected run failure that must not be persisted");
          return counterEpisode(prepared.runId, () => undefined);
        },
        retrying: {
          classifyAttemptError(_error, context) {
            classifications.push({ stage: context.stage, ordinal: context.attempt.ordinal });
            return {
              decision: "safe-to-retry" as const,
              code: context.stage === "prepare" ? "counter.prepare-transient" : "counter.run-transient"
            };
          }
        },
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        evaluation: {
          evaluators: [counterEvaluator],
          contextForEpisode(episode, artifact) {
            return {
              id: artifact.runId,
              status: artifact.status,
              initialState: artifact.initialState,
              finalState: artifact.finalState,
              agents: [],
              trajectory: [],
              socialEpisode: episode
            };
          }
        }
      }
    });
    expect(result.runSet).toMatchObject({ gamesCompleted: 1, gamesFailed: 0 });
    expect(classifications).toEqual([
      { stage: "prepare", ordinal: 1 },
      { stage: "run", ordinal: 2 }
    ]);
    expect({ prepareCalls, runCalls }).toEqual({ prepareCalls: 3, runCalls: 2 });
    expect(await runStore.get("classified-retry")).toMatchObject({
      schemaVersion: "harness.experiment-run-record.v3",
      state: "finalized",
      episodes: [{ attempts: [
        { ordinal: 1, outcome: "retry-scheduled", code: "counter.prepare-transient" },
        { ordinal: 2, outcome: "retry-scheduled", code: "counter.run-transient" },
        { ordinal: 3, outcome: "artifact-committed" }
      ] }]
    });
    expect(JSON.stringify(await runStore.get("classified-retry"))).not.toContain("injected");
  });

  it("resumes a durable v3 retry-wait without replaying the ambiguous prior attempt", async () => {
    const root = await temporaryRoot();
    const artifactStore = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "retry-resume-episodes"),
      verifyArtifact
    });
    const runStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "retry-resume-runs"),
      episodeStore: artifactStore
    });
    const spec = {
      ...experimentSpec(),
      episodeCount: 1,
      retryPolicy: { id: "counter.retry", version: "2", maxAttempts: 2, backoffMs: 0 }
    };
    const experiment = createGenericExperimentProvenance(spec);
    await runStore.beginOrResume({ runSetId: "retry-wait-resume", experiment });
    await runStore.startEpisode({
      runSetId: "retry-wait-resume", index: 0, seed: `${spec.seed}:g1`
    });
    await runStore.scheduleEpisodeRetry({
      runSetId: "retry-wait-resume", code: "counter.prepare-transient", backoffMs: 0
    });
    let prepareCalls = 0;
    let runCalls = 0;
    await runGenericExperiment({
      spec,
      runSetId: "retry-wait-resume",
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          prepareCalls += 1;
          return { runId: `${context.spec.id}:${context.seed}` };
        },
        runEpisode(prepared) {
          runCalls += 1;
          return counterEpisode(prepared.runId, () => undefined);
        },
        retrying: {
          classifyAttemptError() {
            throw new Error("completed resumed attempt must not classify an error");
          }
        },
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        evaluation: {
          evaluators: [counterEvaluator],
          contextForEpisode(episode, artifact) {
            return {
              id: artifact.runId,
              status: artifact.status,
              initialState: artifact.initialState,
              finalState: artifact.finalState,
              agents: [],
              trajectory: [],
              socialEpisode: episode
            };
          }
        }
      }
    });
    expect({ prepareCalls, runCalls }).toEqual({ prepareCalls: 1, runCalls: 1 });
    expect(await runStore.get("retry-wait-resume")).toMatchObject({
      state: "finalized",
      episodes: [{ attempts: [
        { ordinal: 1, outcome: "retry-scheduled" },
        { ordinal: 2, outcome: "artifact-committed" }
      ] }]
    });
  });

  it("fails missing evaluator and adapter identity preflight before preparing an episode", async () => {
    let preparations = 0;
    const base = {
      spec: experimentSpec(),
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode() {
          preparations += 1;
          return {};
        },
        runEpisode: async () => {
          throw new Error("must not run");
        },
        lifecycleOf: () => "failed" as const,
        artifactForEpisode: async () => {
          throw new Error("must not materialize");
        },
        evaluation: {
          evaluators: [],
          contextForEpisode() {
            throw new Error("must not evaluate");
          }
        }
      }
    };

    await expect(runGenericExperiment(base)).rejects.toThrow(/registry is missing: counter.value.v1/i);
    expect(preparations).toBe(0);
    await expect(
      runGenericExperiment({ ...base, adapter: { ...base.adapter, domainId: "wrong-domain" } })
    ).rejects.toThrow(/domainId must match/i);
    expect(preparations).toBe(0);
  });

  it("fails closed on checkpoint policies that lack executable runtime authority", async () => {
    let preparations = 0;
    let begins = 0;
    const runStore = {
      ...memoryRunStore<Artifact>(),
      async beginOrResume(input: Parameters<GenericExperimentRunStore<Artifact>["beginOrResume"]>[0]) {
        begins += 1;
        return memoryRunStore<Artifact>().beginOrResume(input);
      }
    };
    const adapter = {
      domainId: "counter-orchestration",
      prepareEpisode() {
        preparations += 1;
        return {};
      },
      runEpisode: async () => {
        throw new Error("must not run");
      },
      lifecycleOf: () => "failed" as const,
      artifactForEpisode: async () => {
        throw new Error("must not materialize");
      },
      evaluation: {
        evaluators: [counterEvaluator],
        contextForEpisode() {
          throw new Error("must not evaluate");
        }
      }
    };

    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "final" }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore,
      adapter
    })).rejects.toThrow(/requires a deterministic final checkpoint builder/i);

    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore,
      adapter
    })).rejects.toThrow(/native-boundaries.*requires a deterministic native-boundary checkpoint builder/i);

    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        retryPolicy: { id: "counter.retry", version: "1", maxAttempts: 2 }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore,
      adapter
    })).rejects.toThrow(/requires a domain-owned attempt error classifier/i);

    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore,
      adapter
    })).rejects.toThrow(/requires a domain artifact projector/i);

    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" }
      },
      artifactStore: memoryArtifactStore<Artifact>(),
      runStore,
      adapter: {
        ...adapter,
        artifactProjection: {
          projectArtifact(artifact: Artifact) {
            return counterProjection(artifact, "public");
          }
        } as never
      }
    })).rejects.toThrow(/requires a domain projection validator/i);

    const noProjectionRead = memoryArtifactStore<Artifact>();
    delete noProjectionRead.getProjection;
    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" }
      },
      artifactStore: noProjectionRead,
      runStore,
      adapter: {
        ...adapter,
        artifactProjection: counterProjectionAdapter()
      }
    })).rejects.toThrow(/requires canonical projection read authority/i);

    expect(begins).toBe(0);
    expect(preparations).toBe(0);
  });

  it("projects only after staging and atomically publishes the sidecar without replacing full authority", async () => {
    const lifecycle: string[] = [];
    const baseArtifactStore = memoryArtifactStore<Artifact>();
    const checkpoints = new Map<string, Checkpoint>();
    let publishedArtifact: Artifact | undefined;
    let publishedOptions: Parameters<GenericExperimentArtifactStore<Artifact>["put"]>[1];
    const artifactStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...baseArtifactStore,
      async put(artifact, options) {
        lifecycle.push("put");
        publishedArtifact = structuredClone(artifact);
        publishedOptions = structuredClone(options);
        return baseArtifactStore.put(artifact, options);
      },
      async putCheckpoint(_runId, checkpoint) {
        lifecycle.push("checkpoint");
        checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
      },
      async getCheckpoint(_runId, checkpointId) {
        const checkpoint = checkpoints.get(checkpointId);
        return checkpoint ? structuredClone(checkpoint) : undefined;
      }
    };
    const baseRunStore = memoryRunStore<Artifact>();
    const runStore: GenericExperimentRunStore<Artifact> = {
      ...baseRunStore,
      async stageEpisode(input) {
        lifecycle.push("stage");
        expect(input.episode.artifact.finalState.value).toBe(1);
        return baseRunStore.stageEpisode(input);
      },
      async recordEpisode(input) {
        lifecycle.push("membership");
        return baseRunStore.recordEpisode(input);
      }
    };

    await runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" },
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "final" }
      },
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        artifactProjection: {
          projectArtifact(artifact, visibility, context) {
            lifecycle.push("project");
            const projection = counterProjection(artifact, visibility);
            artifact.finalState.value = 700;
            context.spec.id = "mutated-project-context";
            return projection;
          },
          validateProjection(projection, artifact, context) {
            lifecycle.push("validate-projection");
            expect(artifact.finalState.value).toBe(1);
            expect(context.spec.id).toBe("counter-experiment");
            projection.payload = { mutatedByValidator: true };
            artifact.finalState.value = 800;
            context.spec.id = "mutated-validator-context";
            return [];
          }
        },
        checkpointing: {
          finalCheckpointForArtifact(artifact) {
            expect(artifact.finalState.value).toBe(1);
            return buildCounterFinalCheckpoint(artifact);
          }
        },
        evaluation: {
          evaluators: [counterEvaluator],
          contextForEpisode(episode, artifact) {
            lifecycle.push("evaluate");
            expect(artifact.finalState.value).toBe(1);
            return {
              id: artifact.runId,
              status: artifact.status,
              initialState: artifact.initialState,
              finalState: artifact.finalState,
              agents: [],
              trajectory: [],
              socialEpisode: episode
            };
          }
        }
      }
    });

    expect(lifecycle).toEqual([
      "evaluate",
      "stage",
      "project",
      "validate-projection",
      "put",
      "checkpoint",
      "membership"
    ]);
    expect(publishedArtifact?.finalState.value).toBe(1);
    expect(publishedOptions?.evaluationReport).toBeDefined();
    expect(publishedOptions?.projection).toEqual(counterProjection(publishedArtifact!, "public"));
    expect(checkpoints.values().next().value?.state).toEqual({ value: 1, done: true });
  });

  it("rejects forged projection source and policy bindings before canonical publication", async () => {
    const cases: Array<{
      name: string;
      mutate(projection: HarnessEpisodeProjectionEnvelope): void;
      message: RegExp;
    }> = [
      {
        name: "run id",
        mutate: (projection) => { projection.source.runId = "forged-run"; },
        message: /source does not match/i
      },
      {
        name: "artifact digest",
        mutate: (projection) => { projection.source.artifactSha256 = "0".repeat(64); },
        message: /source does not match/i
      },
      {
        name: "payload digest",
        mutate: (projection) => { projection.payloadSha256 = "0".repeat(64); },
        message: /invalid projection.*payloadSha256/i
      },
      {
        name: "visibility",
        mutate: (projection) => { projection.source.visibility = "postgame-redacted"; },
        message: /policy binding/i
      },
      {
        name: "policy identity",
        mutate: (projection) => {
          projection.source.policyId = "forged.policy";
          projection.source.policyVersion = "99";
        },
        message: /policy binding/i
      }
    ];

    for (const testCase of cases) {
      let puts = 0;
      const authority = memoryArtifactStore<Artifact>();
      await expect(runGenericExperiment({
        spec: {
          ...experimentSpec(),
          episodeCount: 1,
          evaluatorIds: [],
          artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" }
        },
        artifactStore: {
          ...authority,
          async put(artifact, options) {
            puts += 1;
            return authority.put(artifact, options);
          }
        },
        runStore: memoryRunStore<Artifact>(),
        adapter: {
          domainId: "counter-orchestration",
          prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
          runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
          lifecycleOf: (episode) => episode.status,
          artifactForEpisode: (episode) => artifactFromEpisode(episode),
          artifactProjection: {
            projectArtifact(artifact, visibility) {
              const projection = counterProjection(artifact, visibility);
              testCase.mutate(projection);
              return projection;
            },
            validateProjection: () => []
          }
        }
      }), testCase.name).rejects.toThrow(testCase.message);
      expect(puts, testCase.name).toBe(0);
    }
  });

  it("fails closed on domain projection validator evidence before artifact publication", async () => {
    let puts = 0;
    const authority = memoryArtifactStore<Artifact>();
    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        artifactPolicy: { id: "counter.artifact", version: "1", visibility: "postgame-redacted" }
      },
      artifactStore: {
        ...authority,
        async put(artifact, options) {
          puts += 1;
          return authority.put(artifact, options);
        }
      },
      runStore: memoryRunStore<Artifact>(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        artifactProjection: {
          projectArtifact: (artifact, visibility) => counterProjection(artifact, visibility),
          validateProjection: () => ["sentinel-private-field-exposed"]
        }
      }
    })).rejects.toThrow(/sentinel-private-field-exposed/i);
    expect(puts).toBe(0);
  });

  it("returns only canonical projection publications for non-research visibility", async () => {
    for (const visibility of ["public", "postgame-redacted"] as const) {
      const privateSeedSentinel = `PRIVATE_EXPERIMENT_SEED_${visibility}`;
      const privateArtifactSentinel = `PRIVATE_CANONICAL_ARTIFACT_${visibility}`;
      const privateEvaluationSentinel = `PRIVATE_EVALUATION_${visibility}`;
      const authority = memoryArtifactStore<Artifact>();
      let projectionReads = 0;
      const artifactStore: GenericExperimentArtifactStore<Artifact> = {
        ...authority,
        async getProjection(runId) {
          projectionReads += 1;
          return authority.getProjection?.(runId);
        }
      };
      const spec: GenericExperimentSpecV1 = {
        ...experimentSpec(),
        id: `restricted-${visibility}`,
        seed: privateSeedSentinel,
        episodeCount: 1,
        artifactPolicy: { id: "counter.artifact", version: "1", visibility },
        domainConfig: {
          terminalValue: 1,
          privateArtifactSentinel
        }
      };
      const privateEvaluator: HarnessEvaluator<
        State,
        undefined,
        SocialEpisodeArtifact<State, Observation, Pending, Command>,
        unknown,
        never,
        never
      > = {
        id: "counter.value.v1",
        label: privateEvaluationSentinel,
        version: "1",
        evaluate(context) {
          return {
            evaluatorId: "counter.value.v1",
            label: privateEvaluationSentinel,
            version: "1",
            metrics: [{
              id: "episode.counter_value",
              label: privateEvaluationSentinel,
              source: "counter.value.v1",
              scope: "episode",
              value: context.finalState.value,
              weight: 1,
              evidenceRefs: []
            }]
          };
        }
      };

      const result = await runGenericExperiment({
        spec,
        runSetId: `restricted-run-set-${visibility}`,
        artifactStore,
        runStore: memoryRunStore<Artifact>(),
        now: () => "2026-07-22T14:00:00.000Z",
        adapter: {
          domainId: "counter-orchestration",
          prepareEpisode: (context) => ({ runId: `restricted-run-${visibility}-${context.index}` }),
          runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
          lifecycleOf: (episode) => episode.status,
          artifactForEpisode(episode) {
            const artifact = artifactFromEpisode(episode);
            (artifact as Artifact & { privateArtifactSentinel: string }).privateArtifactSentinel = privateArtifactSentinel;
            return artifact;
          },
          artifactProjection: counterProjectionAdapter(),
          evaluation: {
            evaluators: [privateEvaluator],
            contextForEpisode(episode, artifact) {
              return {
                id: artifact.runId,
                status: artifact.status,
                initialState: artifact.initialState,
                finalState: artifact.finalState,
                agents: [],
                trajectory: [],
                socialEpisode: episode
              };
            }
          }
        }
      });

      const outward = result as unknown as Record<string, unknown>;
      expect(outward).not.toHaveProperty("normalizedSpec");
      expect(outward).not.toHaveProperty("experiment");
      expect(result.tournament).not.toHaveProperty("seed");
      expect(result.tournament.episodes[0]).not.toHaveProperty("seed");
      expect(result.tournament.episodes[0]).not.toHaveProperty("result");
      expect(result.runSet).not.toHaveProperty("seed");
      expect(result.runSet).not.toHaveProperty("experiment");
      expect(result.runSet.episodes[0]).not.toHaveProperty("seed");
      expect(result.runSet.episodes[0]).not.toHaveProperty("artifact");
      expect(result.runSet.episodes[0]).not.toHaveProperty("evaluationReport");
      expect(result.publication).toMatchObject({
        schemaVersion: "harness.experiment-publication.v1",
        kind: "experiment-publication",
        visibility,
        artifactPolicy: { id: "counter.artifact", version: "1" },
        domainId: "counter-orchestration",
        runSetId: `restricted-run-set-${visibility}`,
        gamesRequested: 1,
        gamesCompleted: 1,
        gamesFailed: 0,
        gamesUnstarted: 0,
        episodes: [{
          index: 0,
          status: "completed",
          runId: `restricted-run-${visibility}-0`,
          projection: {
            schemaVersion: HARNESS_EPISODE_PROJECTION_VERSION,
            kind: "episode-projection",
            source: { visibility, policyId: "counter.artifact", policyVersion: "1" },
            payload: { kind: "counter-projection", status: "completed", finalValue: 1 }
          }
        }]
      });
      expect(projectionReads).toBe(1);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(privateSeedSentinel);
      expect(serialized).not.toContain(privateArtifactSentinel);
      expect(serialized).not.toContain(privateEvaluationSentinel);

      const canonical = await authority.get(`restricted-run-${visibility}-0`);
      expect(JSON.stringify(canonical)).toContain(privateArtifactSentinel);
      expect(JSON.stringify(canonical)).toContain(privateSeedSentinel);
      expect(JSON.stringify(await authority.getEvaluationReport(`restricted-run-${visibility}-0`)))
        .toContain(privateEvaluationSentinel);
    }
  });

  it("hydrates a finalized full artifact and its bound sidecar without re-running the projector", async () => {
    const root = await temporaryRoot();
    const artifactStore = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact
    });
    const runStore = await HarnessExperimentRunStore.open({
      baseDirectory: path.join(root, "experiment-runs"),
      episodeStore: artifactStore,
      now: () => "2026-07-22T14:00:00.000Z"
    });
    const spec = {
      ...experimentSpec(),
      episodeCount: 1,
      evaluatorIds: [],
      artifactPolicy: { id: "counter.artifact", version: "1", visibility: "public" as const }
    };
    let projections = 0;
    const first = await runGenericExperiment({
      spec,
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        artifactProjection: {
          projectArtifact(artifact, visibility) {
            projections += 1;
            return counterProjection(artifact, visibility);
          },
          validateProjection: () => []
        }
      },
      now: () => "2026-07-22T14:00:00.000Z"
    });
    expect(projections).toBe(1);

    const resumed = await runGenericExperiment({
      spec,
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode() { throw new Error("finalized resume must not prepare"); },
        runEpisode() { throw new Error("finalized resume must not execute"); },
        lifecycleOf() { throw new Error("finalized resume must not inspect lifecycle"); },
        artifactForEpisode() { throw new Error("finalized resume must not materialize full artifact"); },
        artifactProjection: {
          projectArtifact() { throw new Error("finalized resume must not reproject"); },
          validateProjection() { throw new Error("finalized resume must not revalidate domain projection"); }
        }
      },
      now: () => "2026-07-22T14:00:00.000Z"
    });

    expect(projections).toBe(1);
    expect(resumed.runSet).toEqual(first.runSet);
    expect(resumed.publication).toEqual(first.publication);
    expect(resumed as unknown as Record<string, unknown>).not.toHaveProperty("normalizedSpec");
    expect(resumed.runSet.episodes[0]).not.toHaveProperty("artifact");
    expect(await artifactStore.getProjection(first.runSet.episodes[0]!.runId!)).toBeDefined();
  });

  it("publishes harness-selected committed sequential boundaries before terminal membership", async () => {
    const checkpoints = new Map<string, Checkpoint>();
    const lifecycle: string[] = [];
    const artifactAuthority = memoryArtifactStore<Artifact>();
    const artifactStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...artifactAuthority,
      async put(artifact, options) {
        lifecycle.push("artifact");
        return artifactAuthority.put(artifact, options);
      },
      async putCheckpoint(_runId, checkpoint) {
        lifecycle.push(`checkpoint:${checkpoint.source.nativeStepCount}`);
        checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
      },
      async getCheckpoint(_runId, checkpointId) {
        const checkpoint = checkpoints.get(checkpointId);
        return checkpoint ? structuredClone(checkpoint) : undefined;
      }
    };
    const baseRunStore = memoryRunStore<Artifact>();
    const runStore: GenericExperimentRunStore<Artifact> = {
      ...baseRunStore,
      async recordEpisode(input) {
        lifecycle.push("membership");
        return baseRunStore.recordEpisode(input);
      }
    };
    const boundaries: Array<{ nativeStepCount: number; traceId: string }> = [];

    await runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" }
      },
      artifactStore,
      runStore,
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        checkpointing: {
          nativeCheckpointForArtifactBoundary(artifact, boundary) {
            boundaries.push(structuredClone(boundary));
            return buildCounterNativeCheckpoint(artifact, boundary.nativeStepCount);
          }
        }
      }
    });

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ nativeStepCount: 1 });
    expect(checkpoints).toHaveLength(1);
    expect(lifecycle).toEqual(["artifact", "checkpoint:1", "membership"]);
  });

  it("publishes one checkpoint only at the end of a complete parallel joint batch", async () => {
    const checkpoints = new Map<string, Checkpoint>();
    const boundaries: number[] = [];
    let observedEpisode: SocialEpisodeArtifact<State, Observation, Pending, Command> | undefined;
    const artifactAuthority = memoryArtifactStore<Artifact>();
    const artifactStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...artifactAuthority,
      async get(runId) {
        const artifact = await artifactAuthority.get(runId);
        if (artifact) {
          expect(artifact.socialEpisode.steps.map((_step, index) =>
            isSafeHarnessCheckpointBoundary(artifact.socialEpisode.steps, index)
          )).toEqual([false, true]);
          expect(artifact.socialEpisode.steps.map(isSocialStepCommitted)).toEqual([true, true]);
        }
        return artifact;
      },
      async putCheckpoint(_runId, checkpoint) {
        checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
      },
      async getCheckpoint(_runId, checkpointId) {
        const checkpoint = checkpoints.get(checkpointId);
        return checkpoint ? structuredClone(checkpoint) : undefined;
      }
    };
    const spec: GenericExperimentSpecV1 = {
      ...experimentSpec(),
      episodeCount: 1,
      actorCount: 2,
      schedulerMode: "parallel",
      profiles: [
        { id: "counter-profile-a", version: "1", policyId: "counter.policy" },
        { id: "counter-profile-b", version: "1", policyId: "counter.policy" }
      ],
      evaluatorIds: [],
      checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" }
    };

    const execution = await runGenericExperiment({
      spec,
      artifactStore,
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => parallelCounterEpisode(prepared.runId),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode(episode) {
          observedEpisode = structuredClone(episode);
          return artifactFromEpisode(episode);
        },
        checkpointing: {
          nativeCheckpointForArtifactBoundary(artifact, boundary) {
            boundaries.push(boundary.nativeStepCount);
            return buildCounterNativeCheckpoint(artifact, boundary.nativeStepCount);
          }
        }
      }
    });

    expect(execution.normalizedSpec.checkpointPolicy.mode).toBe("native-boundaries");
    expect(observedEpisode?.status).toBe("completed");
    expect(observedEpisode?.steps).toHaveLength(2);
    expect(validateGenericExperimentExecutionEvidence(execution.normalizedSpec, observedEpisode!)).toEqual([]);
    expect(validateSocialParallelBatchLayout(observedEpisode!.steps)).toEqual([]);
    expect(observedEpisode!.steps.map((_step, index) =>
      isSafeHarnessCheckpointBoundary(observedEpisode!.steps, index)
    )).toEqual([false, true]);
    expect(boundaries).toEqual([2]);
    expect([...checkpoints.values()].map((checkpoint) => checkpoint.source.nativeStepCount)).toEqual([2]);
  });

  it("skips rejected native records and rejects a conflicting canonical boundary checkpoint", async () => {
    let builderCalls = 0;
    const rejectedAuthority = memoryArtifactStore<Artifact>();
    const rejectedStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...rejectedAuthority,
      async putCheckpoint() {
        throw new Error("rejected records must not publish checkpoints");
      },
      async getCheckpoint() {
        return undefined;
      }
    };
    await runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" }
      },
      artifactStore: rejectedStore,
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode(episode) {
          const artifact = artifactFromEpisode(episode);
          artifact.socialEpisode.steps[0]!.commitStatus = "rejected";
          artifact.socialEpisode.steps[0]!.error = "reviewed rejection";
          return artifact;
        },
        checkpointing: {
          nativeCheckpointForArtifactBoundary() {
            builderCalls += 1;
            throw new Error("rejected boundary must not be built");
          }
        }
      }
    });
    expect(builderCalls).toBe(0);

    const checkpointAuthority = new Map<string, Checkpoint>();
    const collisionArtifactAuthority = memoryArtifactStore<Artifact>();
    const collisionStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...collisionArtifactAuthority,
      async putCheckpoint() {
        throw new Error("conflicting checkpoint must fail before publication");
      },
      async getCheckpoint(_runId, checkpointId) {
        const checkpoint = checkpointAuthority.get(checkpointId);
        return checkpoint ? structuredClone(checkpoint) : undefined;
      }
    };
    await expect(runGenericExperiment({
      spec: {
        ...experimentSpec(),
        episodeCount: 1,
        evaluatorIds: [],
        checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" }
      },
      artifactStore: collisionStore,
      runStore: memoryRunStore(),
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
        runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
        lifecycleOf: (episode) => episode.status,
        artifactForEpisode: (episode) => artifactFromEpisode(episode),
        checkpointing: {
          nativeCheckpointForArtifactBoundary(artifact, boundary) {
            const candidate = buildCounterNativeCheckpoint(artifact, boundary.nativeStepCount);
            checkpointAuthority.set(candidate.checkpointId, {
              ...structuredClone(candidate),
              reason: "different deterministic candidate"
            });
            return candidate;
          }
        }
      }
    })).rejects.toThrow(/canonical native-boundary checkpoint identity conflicts/i);
  });

  it("repairs a missing native-boundary checkpoint from canonical authority without rerunning the episode", async () => {
    const root = await temporaryRoot();
    let decisions = 0;
    let failCheckpointPublication = true;
    const openAuthorities = async () => {
      const store = await HarnessEpisodeArtifactStore.open<Artifact, Checkpoint>({
        baseDirectory: path.join(root, "native-boundary-episodes"),
        verifyArtifact,
        verifyCheckpoint(checkpoint) {
          const mismatches = validateHarnessCheckpointEnvelope(checkpoint);
          return { ok: mismatches.length === 0, mismatches };
        }
      });
      const runStore = await HarnessExperimentRunStore.open({
        baseDirectory: path.join(root, "native-boundary-runs"),
        episodeStore: store,
        now: () => "2026-07-22T14:00:00.000Z"
      });
      return { store, runStore };
    };
    const spec = {
      ...experimentSpec(),
      episodeCount: 1,
      evaluatorIds: [],
      checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "native-boundaries" as const }
    };
    const adapter = {
      domainId: "counter-orchestration",
      prepareEpisode(context: { seed: string; spec: { id: string } }) {
        return { runId: `${context.spec.id}:${context.seed}` };
      },
      runEpisode(prepared: { runId: string }) {
        return counterEpisode(prepared.runId, () => { decisions += 1; });
      },
      lifecycleOf: (episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) => episode.status,
      artifactForEpisode: (episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) => artifactFromEpisode(episode),
      checkpointing: {
        nativeCheckpointForArtifactBoundary(artifact: Artifact, boundary: { nativeStepCount: number }) {
          return buildCounterNativeCheckpoint(artifact, boundary.nativeStepCount);
        }
      }
    };

    const first = await openAuthorities();
    await expect(runGenericExperiment({
      spec,
      artifactStore: {
        put: (artifact, options) => first.store.put(artifact, options),
        get: (runId) => first.store.get(runId),
        getEvaluationReport: (runId) => first.store.getEvaluationReport(runId),
        getCheckpoint: (runId, checkpointId) => first.store.getCheckpoint(runId, checkpointId),
        async putCheckpoint(runId, checkpoint) {
          if (failCheckpointPublication) {
            failCheckpointPublication = false;
            throw new Error("injected native checkpoint publication failure");
          }
          return first.store.putCheckpoint(runId, checkpoint);
        }
      },
      runStore: first.runStore,
      adapter
    })).rejects.toThrow(/injected native checkpoint publication failure/i);
    expect(decisions).toBe(1);

    const restarted = await openAuthorities();
    const result = await runGenericExperiment({
      spec,
      artifactStore: restarted.store,
      runStore: restarted.runStore,
      adapter
    });
    expect(decisions).toBe(1);
    const runId = result.runSet.episodes[0]?.runId;
    expect(runId).toBeTruthy();
    await expect(restarted.store.listCheckpoints(runId!)).resolves.toHaveLength(1);
  });

  it("rejects final checkpoints that drift from canonical agent or execution-prefix authority before publication", async () => {
    const cases: Array<{
      name: string;
      mutate(checkpoint: Checkpoint): void;
    }> = [
      {
        name: "agents",
        mutate(checkpoint) {
          checkpoint.agents = [{} as never];
          checkpoint.source.agentsHash = hashStableState(checkpoint.agents);
        }
      },
      {
        name: "executionPrefix.status",
        mutate(checkpoint) {
          checkpoint.executionPrefix.status = "failed";
          checkpoint.executionPrefix.failureReason = "forged checkpoint lifecycle";
          checkpoint.executionPrefix.error = "forged checkpoint lifecycle";
          checkpoint.source.executionPrefixHash = hashStableState(checkpoint.executionPrefix);
        }
      },
      {
        name: "executionPrefix.initialState",
        mutate(checkpoint) {
          checkpoint.executionPrefix.initialState = { value: 99, done: false };
          checkpoint.source.executionPrefixHash = hashStableState(checkpoint.executionPrefix);
        }
      },
      {
        name: "executionPrefix.channels",
        mutate(checkpoint) {
          checkpoint.executionPrefix.channels.push({
            id: "forged-public-channel",
            kind: "public",
            participantIds: ["a"],
            readableBy: "all"
          });
          checkpoint.source.channelsHash = hashStableState(checkpoint.executionPrefix.channels);
          checkpoint.source.executionPrefixHash = hashStableState(checkpoint.executionPrefix);
        }
      }
    ];

    for (const testCase of cases) {
      let checkpointPuts = 0;
      const artifactAuthority = memoryArtifactStore<Artifact>();
      const checkpointAuthority = new Map<string, Checkpoint>();
      const artifactStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
        ...artifactAuthority,
        async putCheckpoint(_runId, checkpoint) {
          checkpointPuts += 1;
          checkpointAuthority.set(checkpoint.checkpointId, structuredClone(checkpoint));
        },
        async getCheckpoint(_runId, checkpointId) {
          const checkpoint = checkpointAuthority.get(checkpointId);
          return checkpoint ? structuredClone(checkpoint) : undefined;
        }
      };

      await expect(runGenericExperiment({
        spec: {
          ...experimentSpec(),
          episodeCount: 1,
          evaluatorIds: [],
          checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "final" }
        },
        artifactStore,
        runStore: memoryRunStore(),
        adapter: {
          domainId: "counter-orchestration",
          prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
          runEpisode: (prepared) => counterEpisode(prepared.runId, () => undefined),
          lifecycleOf: (episode) => episode.status,
          artifactForEpisode: (episode) => artifactFromEpisode(episode),
          checkpointing: {
            finalCheckpointForArtifact(artifact) {
              const checkpoint = buildCounterFinalCheckpoint(artifact);
              testCase.mutate(checkpoint);
              return checkpoint;
            }
          }
        }
      }), testCase.name).rejects.toThrow(/final checkpoint/i);
      expect(checkpointPuts, testCase.name).toBe(0);
    }
  });

  it("bounds a non-resolving final checkpoint builder by the experiment deadline", async () => {
    let builderCalls = 0;
    let checkpointPuts = 0;
    const artifactAuthority = memoryArtifactStore<Artifact>();
    const artifactStore: GenericExperimentArtifactStore<Artifact, Checkpoint> = {
      ...artifactAuthority,
      async putCheckpoint() {
        checkpointPuts += 1;
      },
      async getCheckpoint() {
        return undefined;
      }
    };
    const startedAt = Date.now();
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runGenericExperiment({
        spec: {
          ...experimentSpec(),
          episodeCount: 1,
          evaluatorIds: [],
          timeoutPolicy: {
            id: "counter.timeout",
            version: "1",
            runTimeoutMs: 500,
            decisionTimeoutMs: 100
          },
          checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "final" }
        },
        artifactStore,
        runStore: memoryRunStore(),
        adapter: {
          domainId: "counter-orchestration",
          prepareEpisode: (context) => ({ runId: `${context.spec.id}:${context.seed}` }),
          runEpisode: (prepared, context) => counterEpisode(prepared.runId, () => undefined, {
            maxTransitions: context.spec.maxTransitions,
            decisionTimeoutMs: context.spec.timeoutPolicy.decisionTimeoutMs
          }),
          lifecycleOf: (episode) => episode.status,
          artifactForEpisode: (episode) => artifactFromEpisode(episode),
          checkpointing: {
            finalCheckpointForArtifact() {
              builderCalls += 1;
              return new Promise<Checkpoint>(() => undefined);
            }
          }
        }
      }).then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "guard" }>((resolve) => {
        guard = setTimeout(() => resolve({ kind: "guard" }), 1_500);
      })
    ]);
    if (guard) clearTimeout(guard);

    expect(builderCalls).toBe(1);
    expect(outcome).toMatchObject({ kind: "rejected" });
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/aborted|deadline|timeout/i);
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(checkpointPuts).toBe(0);
  }, 3_000);

  it("repairs the artifact-to-checkpoint crash window before scheduling the remaining suffix", async () => {
    const root = await temporaryRoot();
    let decisions = 0;
    let failCheckpointPublication = true;
    const openAuthorities = async () => {
      const store = await HarnessEpisodeArtifactStore.open<Artifact, Checkpoint>({
        baseDirectory: path.join(root, "episodes"),
        verifyArtifact,
        verifyCheckpoint(checkpoint) {
          const mismatches = validateHarnessCheckpointEnvelope(checkpoint);
          return { ok: mismatches.length === 0, mismatches };
        }
      });
      const runStore = await HarnessExperimentRunStore.open({
        baseDirectory: path.join(root, "experiment-runs"),
        episodeStore: store,
        now: () => "2026-07-22T14:00:00.000Z"
      });
      return { store, runStore };
    };
    const adapter = {
      domainId: "counter-orchestration",
      prepareEpisode(context: { index: number; seed: string; spec: { id: string } }) {
        return { runId: `${context.spec.id}:${context.seed}` };
      },
      runEpisode(prepared: { runId: string }) {
        return counterEpisode(prepared.runId, () => { decisions += 1; });
      },
      lifecycleOf: (episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) => episode.status,
      artifactForEpisode(episode: SocialEpisodeArtifact<State, Observation, Pending, Command>) {
        return artifactFromEpisode(episode);
      },
      checkpointing: {
        finalCheckpointForArtifact: buildCounterFinalCheckpoint
      },
      evaluation: {
        evaluators: [counterEvaluator],
        contextForEpisode(
          episode: SocialEpisodeArtifact<State, Observation, Pending, Command>,
          artifact: Artifact
        ) {
          return {
            id: artifact.runId,
            status: artifact.status,
            initialState: artifact.initialState,
            finalState: artifact.finalState,
            agents: [] as never[],
            trajectory: [] as never[],
            socialEpisode: episode
          };
        }
      }
    };
    const spec = {
      ...experimentSpec(),
      checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "final" as const }
    };
    const first = await openAuthorities();
    await expect(runGenericExperiment({
      spec,
      artifactStore: {
        put: (artifact, options) => first.store.put(artifact, options),
        get: (runId) => first.store.get(runId),
        getEvaluationReport: (runId) => first.store.getEvaluationReport(runId),
        getCheckpoint: (runId, checkpointId) => first.store.getCheckpoint(runId, checkpointId),
        async putCheckpoint(runId, checkpoint) {
          if (failCheckpointPublication) {
            failCheckpointPublication = false;
            throw new Error("injected checkpoint publication failure");
          }
          return first.store.putCheckpoint(runId, checkpoint);
        }
      },
      runStore: first.runStore,
      adapter,
      now: () => "2026-07-22T14:00:00.000Z"
    })).rejects.toThrow(/injected checkpoint publication failure/i);
    expect(decisions).toBe(1);

    const restarted = await openAuthorities();
    const result = await runGenericExperiment({
      spec,
      artifactStore: restarted.store,
      runStore: restarted.runStore,
      adapter,
      now: () => "2026-07-22T14:00:00.000Z"
    });

    expect(decisions).toBe(2);
    expect(result.runSet.episodes).toHaveLength(2);
    for (const episode of result.runSet.episodes) {
      expect(episode.runId).toBeTruthy();
      await expect(restarted.store.listCheckpoints(episode.runId!)).resolves.toHaveLength(1);
    }
  });
});

function experimentSpec(): GenericExperimentSpecV1 {
  return {
    version: "harness.experiment.v1",
    id: "counter-experiment",
    kind: "tournament",
    domainId: "counter-orchestration",
    domainAdapter: adapterManifest,
    seed: "counter-orchestration-seed",
    episodeCount: 2,
    actorCount: 1,
    schedulerMode: "aec",
    profiles: [{ id: "counter-profile", version: "1", policyId: "counter.policy" }],
    modelAssignments: [],
    assignmentPolicy: { id: "counter.assignment", version: "1" },
    maxTransitions: 2,
    timeoutPolicy: { id: "counter.timeout", version: "1", runTimeoutMs: 30_000, decisionTimeoutMs: 5_000 },
    retryPolicy: { id: "counter.retry", version: "1", maxAttempts: 1 },
    evaluatorIds: ["counter.value.v1"],
    artifactPolicy: { id: "counter.artifact", version: "1", visibility: "research-full" },
    checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "none" },
    continueOnError: true,
    domainConfig: { terminalValue: 1 }
  };
}

function artifactFromEpisode(
  socialEpisode: SocialEpisodeArtifact<State, Observation, Pending, Command>
): Artifact {
  return {
    artifactVersion: "counter-orchestration.episode.v1",
    kind: "counter-orchestration-episode",
    runId: socialEpisode.id,
    createdAt: "2026-07-22T14:00:00.000Z",
    status: socialEpisode.status,
    initialState: socialEpisode.initialState,
    finalState: socialEpisode.finalState,
    socialEpisode,
    agents: []
  };
}

function counterProjection(
  artifact: Artifact,
  visibility: "public" | "postgame-redacted"
): HarnessEpisodeProjectionEnvelope {
  const payload = {
    kind: "counter-projection",
    status: artifact.status,
    finalValue: artifact.finalState.value
  };
  return {
    schemaVersion: HARNESS_EPISODE_PROJECTION_VERSION,
    kind: "episode-projection",
    source: {
      runId: artifact.runId,
      artifactSha256: deriveHarnessEpisodeArtifactSha256(artifact),
      visibility,
      policyId: "counter.artifact",
      policyVersion: "1"
    },
    payloadSha256: hashStableJsonValue(payload),
    payload
  };
}

function counterProjectionAdapter() {
  return {
    projectArtifact: (artifact: Artifact, visibility: "public" | "postgame-redacted") =>
      counterProjection(artifact, visibility),
    validateProjection: () => [] as string[]
  };
}

function buildCounterFinalCheckpoint(artifact: Artifact): Checkpoint {
  const executionPrefix = structuredClone(artifact.socialEpisode);
  const boundary = executionPrefix.steps.at(-1);
  return {
    artifactVersion: "counter-orchestration.checkpoint.v1",
    kind: "checkpoint",
    checkpointId: `${artifact.runId}:checkpoint:final`,
    createdAt: artifact.createdAt,
    reason: "experiment checkpointPolicy final",
    source: {
      sourceArtifactVersion: artifact.artifactVersion,
      runId: artifact.runId,
      status: artifact.status,
      boundaryTraceId: boundary?.traceId,
      boundaryTurnIndex: boundary?.turnIndex,
      boundaryBatchId: boundary?.batchId,
      boundaryBatchIndex: boundary?.batchIndex,
      boundarySchedulerMode: boundary?.schedulerMode,
      nativeStepCount: executionPrefix.steps.length,
      messageCount: executionPrefix.messages.length,
      lastMessageSeq: executionPrefix.messages.at(-1)?.seq,
      stateHash: hashStableState(artifact.finalState),
      executionPrefixHash: hashStableState(executionPrefix),
      agentsHash: hashStableState([]),
      channelsHash: hashStableState(executionPrefix.channels),
      messagesHash: hashStableState(executionPrefix.messages),
      domainAdapter: structuredClone(executionPrefix.domainAdapter),
      experiment: structuredClone(artifact.experiment)
    },
    state: structuredClone(artifact.finalState),
    agents: [],
    executionPrefix
  };
}

function buildCounterNativeCheckpoint(artifact: Artifact, nativeStepCount: number): Checkpoint {
  return buildGenericHarnessCheckpointAtPrefix({
    artifactVersion: "counter-orchestration.checkpoint.v1",
    kind: "checkpoint",
    checkpointId: `${artifact.runId}:checkpoint:native:${nativeStepCount}`,
    createdAt: artifact.createdAt,
    reason: "experiment checkpointPolicy native-boundaries",
    sourceArtifactVersion: artifact.artifactVersion,
    runId: artifact.runId,
    sourceStatus: artifact.status,
    episode: artifact.socialEpisode,
    selector: { nativeStepCount },
    experiment: artifact.experiment,
    recordedAgentState: { mode: "validate", validator: () => [] },
    replayPrefix(executionPrefix) {
      const value = executionPrefix.steps.filter(isSocialStepCommitted).reduce((total, step) => {
        const command = step.action.command as Command;
        return total + command.amount;
      }, 0);
      const finalState = { value, done: true };
      return {
        mismatches: [],
        finalState,
        finalHash: hashStableState(finalState),
        messagesHash: hashStableState(executionPrefix.messages)
      };
    }
  });
}

function counterEpisode(
  runId: string,
  onDecision: () => void,
  control: { maxTransitions?: number; decisionTimeoutMs?: number } = {
    maxTransitions: 2,
    decisionTimeoutMs: 5_000
  },
  profile: SocialAgentProfile = {
    id: "counter-profile",
    version: "1",
    model: "deterministic",
    policyId: "counter.policy"
  }
): Promise<SocialEpisodeArtifact<State, Observation, Pending, Command>> {
  const actor: SocialActor<Observation, Pending, Command> = {
    id: "a",
    profile,
    observe() {},
    decide(pending) {
      onDecision();
      return { actorId: "a", kind: "increment", command: { actorId: pending.actorId, amount: 1 } };
    }
  };
  return runHarnessEpisode<State, Observation, Pending, Command>({
    id: runId,
    domainAdapter: adapterManifest,
    environment: new Environment(),
    actors: [actor],
    channels: [],
    captureAgentSnapshots: () => [],
    schedulerMode: "aec",
    ...(control.maxTransitions === undefined ? {} : { maxTransitions: control.maxTransitions }),
    ...(control.decisionTimeoutMs === undefined
      ? {}
      : { executionLimits: { decisionTimeoutMs: control.decisionTimeoutMs } }),
    hashState: hashStableState,
    hashMessages: hashStableState
  });
}

function parallelCounterEpisode(runId: string): Promise<SocialEpisodeArtifact<State, Observation, Pending, Command>> {
  const actors: Array<SocialActor<Observation, Pending, Command>> = ["a", "b"].map((actorId) => ({
    id: actorId,
    profile: {
      id: `counter-profile-${actorId}`,
      version: "1",
      model: "deterministic",
      policyId: "counter.policy"
    },
    observe() {},
    decide(pending) {
      return { actorId, kind: "increment", command: { actorId: pending.actorId, amount: 1 } };
    }
  }));
  return runHarnessEpisode<State, Observation, Pending, Command>({
    id: runId,
    domainAdapter: adapterManifest,
    environment: new ParallelEnvironment(),
    actors,
    channels: [],
    captureAgentSnapshots: () => [],
    schedulerMode: "parallel",
    maxTransitions: 2,
    executionLimits: { decisionTimeoutMs: 5_000 },
    hashState: hashStableState,
    hashMessages: hashStableState
  });
}

function verifyArtifact(artifact: Artifact) {
  return verifyHarnessEpisodeArtifact({
    artifact,
    runtime: {
      domainAdapter: adapterManifest,
      createEnvironment: (initialState) => new Environment(initialState),
      hashState: hashStableState,
      hashMessages: hashStableState,
      validateRecordedStep(step, context) {
        return context.pendingActions[0]?.actorId === step.actorId ? [] : ["pending actor mismatch"];
      },
      recordedAgentState: { mode: "validate", validator: () => [] }
    }
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "generic-experiment-orchestrator-"));
  roots.push(root);
  return root;
}

function memoryArtifactStore<TArtifact extends Artifact>(): GenericExperimentArtifactStore<TArtifact> {
  const artifacts = new Map<string, TArtifact>();
  const evaluations = new Map<string, Parameters<GenericExperimentArtifactStore<TArtifact>["put"]>[1]>();
  return {
    async put(artifact, options) {
      artifacts.set(artifact.runId, structuredClone(artifact));
      evaluations.set(artifact.runId, structuredClone(options));
    },
    async get(runId) {
      const artifact = artifacts.get(runId);
      return artifact ? structuredClone(artifact) : undefined;
    },
    async getEvaluationReport(runId) {
      return structuredClone(evaluations.get(runId)?.evaluationReport);
    },
    async getProjection(runId) {
      return structuredClone(evaluations.get(runId)?.projection);
    }
  };
}

function memoryRunStore<TArtifact extends Artifact>(): GenericExperimentRunStore<TArtifact> {
  let record: HarnessExperimentRunRecordV2 | undefined;
  return {
    async beginOrResume(input) {
      if (!record) {
        const createdAt = input.createdAt ?? "2026-07-22T14:00:00.000Z";
        record = {
          schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
          kind: "experiment-run-record",
          state: "active",
          runSetId: input.runSetId,
          createdAt,
          updatedAt: createdAt,
          experiment: structuredClone(input.experiment),
          gamesRequested: input.experiment.spec.episodeCount,
          gamesCompleted: 0,
          gamesTruncated: 0,
          gamesFailed: 0,
          gamesInFlight: 0,
          gamesUnstarted: input.experiment.spec.episodeCount,
          episodes: []
        };
      }
      return { disposition: "created", record: structuredClone(record), revision: 1 };
    },
    async startEpisode() {},
    async stageEpisode() {},
    async recoverCurrentEpisode() {
      if (!record) throw new Error("memory run was not begun");
      return { disposition: "none", record: structuredClone(record) };
    },
    async recordEpisode() {},
    async finalize() {}
  };
}
