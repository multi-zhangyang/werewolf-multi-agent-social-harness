import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { SocialDomainAdapterManifest } from "../../src/harness/domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "../../src/harness/episodeArtifacts";
import { HarnessEpisodeArtifactStore } from "../../src/harness/episodeArtifactStore";
import { runGenericExperiment } from "../../src/harness/experimentOrchestrator";
import { HarnessExperimentRunStore } from "../../src/harness/experimentRunStore";
import type { GenericExperimentSpecV1 } from "../../src/harness/experimentSpec";
import { hashStableState } from "../../src/harness/hash";
import { runHarnessEpisode } from "../../src/harness/runner";
import type {
  SocialActor,
  SocialAgentProfile,
  SocialEnvironment,
  SocialEpisodeArtifact
} from "../../src/harness/social";
import { verifyHarnessEpisodeArtifact } from "../../src/harness/socialReplay";

type CrashPoint =
  | "after_start"
  | "after_stage"
  | "after_artifact_put"
  | "after_terminal_membership"
  | "after_finalize";

interface State { value: number; done: boolean }
interface Pending { actorId: "a"; kind: "increment" }
interface Observation { actorId: "a"; value: number }
interface Command { actorId: "a"; amount: 1 }
type Artifact = HarnessEpisodeArtifactEnvelope<State, Observation, Pending, Command, never>;

const adapterManifest: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: "counter-crash",
  adapterId: "counter-crash.social",
  adapterVersion: "1",
  semanticHash: hashStableState({ adapter: "counter-crash", version: 1 }),
  components: [
    { kind: "agent_state_schema", id: "counter.none", version: "1", semanticHash: hashStableState({ durable: false }) },
    { kind: "command_codec", id: "counter.command", version: "1", semanticHash: hashStableState({ amount: 1 }) },
    { kind: "environment", id: "counter.environment", version: "1", semanticHash: hashStableState({ terminalValue: 1 }) },
    { kind: "observation_projection", id: "counter.observation", version: "1", semanticHash: hashStableState({ private: false }) },
    { kind: "scheduler", id: "counter.scheduler", version: "1", semanticHash: hashStableState({ mode: "aec" }) }
  ]
};

class Environment implements SocialEnvironment<State, Observation, Pending, Command> {
  private state: State;
  constructor(initial: State = { value: 0, done: false }) { this.state = structuredClone(initial); }
  snapshot(): State { return structuredClone(this.state); }
  pendingActions(): Pending[] { return this.state.done ? [] : [{ actorId: "a", kind: "increment" }]; }
  observe(): Observation { return { actorId: "a", value: this.state.value }; }
  validateAction(command: Command, pending: Pending) {
    return { valid: command.actorId === pending.actorId && command.amount === 1 };
  }
  step(command: Command): State {
    if (this.state.done || command.amount !== 1) throw new Error("invalid counter command");
    this.state = { value: this.state.value + 1, done: true };
    return this.snapshot();
  }
  done(): boolean { return this.state.done; }
}

const profile: SocialAgentProfile = {
  id: "counter-profile",
  version: "1",
  model: "deterministic",
  policyId: "counter.policy"
};

const spec: GenericExperimentSpecV1 = {
  version: "harness.experiment.v1",
  id: "counter-crash-experiment",
  kind: "tournament",
  domainId: "counter-crash",
  domainAdapter: adapterManifest,
  seed: "counter-crash-seed",
  episodeCount: 2,
  actorCount: 1,
  schedulerMode: "aec",
  profiles: [{ id: "counter-profile", version: "1", policyId: "counter.policy" }],
  modelAssignments: [],
  assignmentPolicy: { id: "counter.assignment", version: "1" },
  maxTransitions: 2,
  timeoutPolicy: { id: "counter.timeout", version: "1", runTimeoutMs: 30_000, decisionTimeoutMs: 5_000 },
  retryPolicy: { id: "counter.retry", version: "1", maxAttempts: 1 },
  evaluatorIds: [],
  artifactPolicy: { id: "counter.artifact", version: "1", visibility: "research-full" },
  checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "none" },
  continueOnError: true,
  domainConfig: { terminalValue: 1 }
};

async function main(): Promise<void> {
  const mode = process.argv[2];
  const crashPoint = process.argv[3] as CrashPoint | "none" | undefined;
  const root = process.argv[4];
  if ((mode !== "crash" && mode !== "resume") || !root) throw new Error("Invalid crash worker arguments.");
  if (mode === "crash" && !isCrashPoint(crashPoint)) throw new Error("Invalid crash point.");

  const decisionFile = path.join(root, "actor-decisions.jsonl");
  const episodeStore = await HarnessEpisodeArtifactStore.open<Artifact>({
    baseDirectory: path.join(root, "episodes"),
    verifyArtifact
  });
  const persistedRunStore = await HarnessExperimentRunStore.open({
    baseDirectory: path.join(root, "experiment-runs"),
    episodeStore
  });
  let activeIndex: number | undefined;
  let puts = 0;

  const artifactStore = {
    get: (runId: string) => episodeStore.get(runId),
    getEvaluationReport: (runId: string) => episodeStore.getEvaluationReport(runId),
    async put(artifact: Artifact, options?: Parameters<typeof episodeStore.put>[1]) {
      const entry = await episodeStore.put(artifact, options);
      puts += 1;
      if (mode === "crash" && crashPoint === "after_artifact_put" && puts === 1) {
        await readyAndHang(crashPoint, activeIndex);
      }
      return entry;
    }
  };
  const runStore = {
    beginOrResume: (input: Parameters<typeof persistedRunStore.beginOrResume>[0]) =>
      persistedRunStore.beginOrResume(input),
    async startEpisode(input: Parameters<typeof persistedRunStore.startEpisode>[0]) {
      const record = await persistedRunStore.startEpisode(input);
      activeIndex = input.index;
      if (mode === "crash" && crashPoint === "after_start" && input.index === 0) {
        await readyAndHang(crashPoint, input.index);
      }
      return record;
    },
    async stageEpisode(input: Parameters<typeof persistedRunStore.stageEpisode>[0]) {
      const record = await persistedRunStore.stageEpisode(input);
      if (mode === "crash" && crashPoint === "after_stage" && input.episode.index === 0) {
        await readyAndHang(crashPoint, input.episode.index);
      }
      return record;
    },
    recoverCurrentEpisode: (runSetId: string) => persistedRunStore.recoverCurrentEpisode(runSetId),
    async recordEpisode(input: Parameters<typeof persistedRunStore.recordEpisode>[0]) {
      const entry = await persistedRunStore.recordEpisode(input);
      if (mode === "crash" && crashPoint === "after_terminal_membership" && input.episode.index === 0) {
        await readyAndHang(crashPoint, input.episode.index);
      }
      return entry;
    },
    async finalize(runSet: Parameters<typeof persistedRunStore.finalize>[0]) {
      const entry = await persistedRunStore.finalize(runSet);
      if (mode === "crash" && crashPoint === "after_finalize") await readyAndHang(crashPoint);
      return entry;
    }
  };

  const result = await runGenericExperiment({
    spec,
    artifactStore,
    runStore,
    adapter: {
      domainId: "counter-crash",
      prepareEpisode(context) { return { runId: `${context.spec.id}:${context.seed}`, index: context.index }; },
      runEpisode(prepared, context) {
        return counterEpisode(prepared.runId, prepared.index, context.seed, decisionFile);
      },
      lifecycleOf: (episode) => episode.status,
      artifactForEpisode: artifactFromEpisode
    }
  });
  const record = await persistedRunStore.get("counter-crash-experiment");
  const artifacts = await episodeStore.list();
  await send({
    type: "DONE",
    state: record?.state,
    statuses: result.tournament.episodes.map((episode) => episode.status),
    gamesUnstarted: result.tournament.gamesUnstarted,
    artifactRunIds: artifacts.map((entry) => entry.runId),
    decisions: await decisionRows(decisionFile)
  });
}

async function counterEpisode(
  runId: string,
  index: number,
  seed: string,
  decisionFile: string
): Promise<SocialEpisodeArtifact<State, Observation, Pending, Command>> {
  const actor: SocialActor<Observation, Pending, Command> = {
    id: "a",
    profile,
    observe() {},
    async decide(pending) {
      await appendFile(decisionFile, `${JSON.stringify({ index, seed })}\n`, "utf8");
      return { actorId: "a", kind: "increment", command: { actorId: pending.actorId, amount: 1 } };
    }
  };
  return runHarnessEpisode({
    id: runId,
    domainAdapter: adapterManifest,
    environment: new Environment(),
    actors: [actor],
    channels: [],
    schedulerMode: "aec",
    maxTransitions: 2,
    executionLimits: { decisionTimeoutMs: 5_000 },
    hashState: hashStableState,
    hashMessages: hashStableState
  });
}

function artifactFromEpisode(
  socialEpisode: SocialEpisodeArtifact<State, Observation, Pending, Command>
): Artifact {
  return {
    artifactVersion: "counter-crash.episode.v1",
    kind: "counter-crash-episode",
    runId: socialEpisode.id,
    createdAt: "2026-07-22T14:00:00.000Z",
    status: socialEpisode.status,
    initialState: socialEpisode.initialState,
    finalState: socialEpisode.finalState,
    socialEpisode,
    agents: []
  };
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

async function readyAndHang(crashPoint: CrashPoint, episodeIndex?: number): Promise<never> {
  await send({ type: "READY_TO_KILL", crashPoint, episodeIndex });
  return await new Promise<never>(() => { setInterval(() => undefined, 1_000); });
}

function send(message: unknown): Promise<void> {
  if (!process.send) return Promise.reject(new Error("Crash worker requires IPC."));
  return new Promise((resolve, reject) => {
    process.send!(message, (error) => error ? reject(error) : resolve());
  });
}

async function decisionRows(file: string): Promise<Array<{ index: number; seed: string }>> {
  try {
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isCrashPoint(value: unknown): value is CrashPoint {
  return value === "after_start" || value === "after_stage" || value === "after_artifact_put" ||
    value === "after_terminal_membership" || value === "after_finalize";
}

main().catch((error) => {
  send({ type: "ERROR", message: error instanceof Error ? error.message : "Crash worker failed." })
    .finally(() => { process.exitCode = 1; });
});
