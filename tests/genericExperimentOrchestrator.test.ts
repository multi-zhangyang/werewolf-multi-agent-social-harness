import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "../src/harness/episodeArtifacts";
import { HarnessEpisodeArtifactStore } from "../src/harness/episodeArtifactStore";
import {
  runGenericExperiment,
  type GenericExperimentArtifactStore,
  type GenericExperimentRunStore
} from "../src/harness/experimentOrchestrator";
import { HarnessExperimentRunStore } from "../src/harness/experimentRunStore";
import {
  createGenericExperimentProvenance,
  type GenericExperimentSpecV1
} from "../src/harness/experimentSpec";
import type { HarnessEvaluator } from "../src/harness/evaluation";
import { hashStableState } from "../src/harness/hash";
import { runHarnessEpisode } from "../src/harness/runner";
import type { SocialActor, SocialAgentProfile, SocialEnvironment, SocialEpisodeArtifact } from "../src/harness/social";
import { verifyHarnessEpisodeArtifact } from "../src/harness/socialReplay";

interface State {
  value: number;
  done: boolean;
}

interface Pending {
  actorId: "a";
  kind: "increment";
}

interface Observation {
  actorId: "a";
  value: number;
}

interface Command {
  actorId: "a";
  amount: 1;
}

type Artifact = HarnessEpisodeArtifactEnvelope<State, Observation, Pending, Command, never>;

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
      }
    };
    const runStore: GenericExperimentRunStore<Artifact> = {
      async begin(input) {
        lifecycle.push("begin");
        return persistedRunStore.begin(input);
      },
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
      "prepare:0",
      "put:0",
      "record:0",
      "prepare:1",
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
        async put() {
          lifecycle.push("artifact-put");
          throw new Error("canonical artifact storage unavailable");
        }
      },
      runStore: {
        async begin() {
          lifecycle.push("begin");
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

    expect(lifecycle).toEqual(["begin", "prepare:0", "artifact-put"]);
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
        async put() {
          lifecycle.push("artifact-put");
        }
      },
      runStore: {
        async begin() {
          lifecycle.push("begin");
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

    expect(lifecycle).toEqual(["begin", "prepare:0", "artifact-put", "record"]);
  });

  it("isolates callback mutations and enforces an in-flight experiment deadline", async () => {
    const socialEpisode = await counterEpisode("counter-experiment:counter-orchestration-seed:g1", () => undefined);
    const mutationResult = await runGenericExperiment({
      spec: { ...experimentSpec(), episodeCount: 1, evaluatorIds: [] },
      artifactStore: { put: async () => undefined },
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
      artifactStore: { put: async () => undefined },
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
      artifactStore: { put: async () => { puts += 1; } },
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
        artifactStore: { async put() { puts += 1; } },
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

  it("fails missing evaluator and adapter identity preflight before preparing an episode", async () => {
    let preparations = 0;
    const base = {
      spec: experimentSpec(),
      artifactStore: { put: async () => undefined },
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
    schedulerMode: "aec",
    ...(control.maxTransitions === undefined ? {} : { maxTransitions: control.maxTransitions }),
    ...(control.decisionTimeoutMs === undefined
      ? {}
      : { executionLimits: { decisionTimeoutMs: control.decisionTimeoutMs } }),
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
      recordedAgentState: { mode: "none", reason: "counter fixture has no durable actor-state snapshot" }
    }
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "generic-experiment-orchestrator-"));
  roots.push(root);
  return root;
}

function memoryRunStore() {
  return {
    async begin() {},
    async recordEpisode() {},
    async finalize() {}
  };
}
