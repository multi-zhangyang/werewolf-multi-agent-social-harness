import type { HarnessEpisodeArtifactEnvelope } from "../../src/harness/episodeArtifacts";
import { createGenericExperimentProvenance, type GenericExperimentSpecV1 } from "../../src/harness/experimentSpec";
import { HarnessExperimentRunStore } from "../../src/harness/experimentRunStore";

type Artifact = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

const root = process.argv[2];
if (!root) throw new Error("Concurrent run-store worker requires a root path.");

const authority = {
  async get(): Promise<Artifact | undefined> { return undefined; },
  async getMetrics() { return undefined; },
  async getFailures() { return undefined; },
  async getEvaluationReport() { return undefined; }
};

const spec: GenericExperimentSpecV1 = {
  version: "harness.experiment.v1",
  id: "concurrent-process-experiment",
  kind: "tournament",
  domainId: "concurrent-ledger",
  domainAdapter: {
    schemaVersion: "harness.domain-adapter.v1",
    domainId: "concurrent-ledger",
    adapterId: "concurrent-ledger.social",
    adapterVersion: "1",
    semanticHash: "concurrent-ledger-adapter-v1",
    components: [
      { kind: "agent_state_schema", id: "ledger.state", version: "1", semanticHash: "state-v1" },
      { kind: "command_codec", id: "ledger.command", version: "1", semanticHash: "command-v1" },
      { kind: "environment", id: "ledger.environment", version: "1", semanticHash: "environment-v1" },
      { kind: "observation_projection", id: "ledger.observation", version: "1", semanticHash: "observation-v1" },
      { kind: "scheduler", id: "ledger.scheduler", version: "1", semanticHash: "scheduler-v1" }
    ]
  },
  seed: "concurrent-process-seed",
  episodeCount: 1,
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

const store = await HarnessExperimentRunStore.open({ baseDirectory: root, episodeStore: authority });
process.send?.({ type: "READY" });
process.once("message", async (message) => {
  if (message !== "GO") return;
  try {
    const experiment = createGenericExperimentProvenance(spec);
    const begun = await store.beginOrResume({
      runSetId: "cross-process-cas",
      experiment,
      createdAt: "2026-07-22T15:00:00.000Z"
    });
    const started = await store.startEpisode({
      runSetId: "cross-process-cas",
      index: 0,
      seed: `${experiment.spec.seed}:g1`
    });
    process.send?.({
      type: "DONE",
      disposition: begun.disposition,
      attemptId: started.currentEpisode?.attemptId
    });
    process.exit(0);
  } catch (error) {
    process.send?.({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
});
