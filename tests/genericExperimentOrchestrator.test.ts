import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "../src/harness/episodeArtifacts";
import { HarnessEpisodeArtifactStore } from "../src/harness/episodeArtifactStore";
import { runGenericExperiment } from "../src/harness/experimentOrchestrator";
import { HarnessExperimentRunStore } from "../src/harness/experimentRunStore";
import {
  createGenericExperimentProvenance,
  type GenericExperimentSpecV1
} from "../src/harness/experimentSpec";
import type { HarnessEvaluator } from "../src/harness/evaluation";
import { hashStableState } from "../src/harness/hash";
import { runHarnessEpisode } from "../src/harness/runner";
import type { SocialActor, SocialEnvironment, SocialEpisodeArtifact } from "../src/harness/social";
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
    const result = await runGenericExperiment({
      spec: experimentSpec(),
      artifactStore: store,
      runStore: {
        async begin(input) {
          lifecycle.push("begin");
          return persistedRunStore.begin(input);
        },
        async finalize(runSet) {
          lifecycle.push("finalize");
          return persistedRunStore.finalize(runSet);
        }
      },
      now: () => "2026-07-22T14:00:00.000Z",
      adapter: {
        domainId: "counter-orchestration",
        prepareEpisode(context) {
          lifecycle.push(`prepare:${context.index}`);
          preparations += 1;
          return { runId: `${context.spec.id}:${context.seed}`, context };
        },
        async runEpisode(prepared) {
          return counterEpisode(prepared.runId, () => {
            decisions += 1;
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
    expect((await store.list()).map((entry) => entry.runId)).toEqual([
      "counter-experiment:counter-orchestration-seed:g1",
      "counter-experiment:counter-orchestration-seed:g2"
    ]);
    expect(preparations).toBe(2);
    expect(decisions).toBe(2);
    expect(lifecycle).toEqual(["begin", "prepare:0", "prepare:1", "finalize"]);

    const restarted = await HarnessEpisodeArtifactStore.open<Artifact>({
      baseDirectory: path.join(root, "episodes"),
      verifyArtifact
    });
    expect(await restarted.list()).toHaveLength(2);
    expect(await restarted.getMetrics("counter-experiment:counter-orchestration-seed:g1")).toMatchObject([
      { id: "episode.counter_value", value: 1 }
    ]);
    expect(await restarted.getFailures("counter-experiment:counter-orchestration-seed:g1")).toEqual([]);
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
        { index: 0, runId: "counter-experiment:counter-orchestration-seed:g1", metricCount: 1 },
        { index: 1, runId: "counter-experiment:counter-orchestration-seed:g2", metricCount: 1 }
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
  onDecision: () => void
): Promise<SocialEpisodeArtifact<State, Observation, Pending, Command>> {
  const actor: SocialActor<Observation, Pending, Command> = {
    id: "a",
    profile: { id: "counter-profile", model: "deterministic", policyId: "counter.policy" },
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
    async finalize() {}
  };
}
