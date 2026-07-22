import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "../src/harness/episodeArtifacts";
import {
  HarnessEpisodeArtifactStore,
  deriveHarnessEpisodeTrajectoryJsonl,
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
