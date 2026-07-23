import { describe, expect, it } from "vitest";
import type { ModelClient } from "../src/agents/modelClient";
import {
  createGenericExperimentExecutionAttestation,
  normalizeGenericExperimentSpec,
  validateGenericExperimentExecutionEvidence
} from "../src/harness/experimentSpec";
import { hashStableState } from "../src/harness/hash";
import { OpenAIHarnessReasoner } from "../src/harness/reasoner";
import { runHarnessEpisode } from "../src/harness/runner";
import {
  validateSocialEpisodeArtifact,
  type SocialActor,
  type SocialAgentProfile,
  type SocialEnvironment,
  type SocialReasonerCallReport
} from "../src/harness/social";

interface CounterState {
  count: number;
  done: boolean;
}

interface CounterPending {
  actorId: string;
  kind: "increment";
}

interface CounterCommand {
  actorId: string;
  type: "increment";
}

class CounterEnvironment implements SocialEnvironment<CounterState, { count: number }, CounterPending, CounterCommand> {
  private state: CounterState = { count: 0, done: false };

  snapshot(): CounterState {
    return structuredClone(this.state);
  }

  pendingActions(): CounterPending[] {
    return this.state.done ? [] : [{ actorId: "counter", kind: "increment" }];
  }

  observe(): { count: number } {
    return { count: this.state.count };
  }

  step(): CounterState {
    this.state = { count: 1, done: true };
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

class CounterActor implements SocialActor<{ count: number }, CounterPending, CounterCommand> {
  readonly id = "counter";
  private transactionId?: string;

  constructor(
    readonly profile: SocialAgentProfile,
    private readonly report?: SocialReasonerCallReport
  ) {}

  observe(_observation: { count: number }, context?: { transactionId?: string }): void {
    this.transactionId = context?.transactionId;
  }

  decide(): { actorId: string; kind: string; command: CounterCommand } {
    return { actorId: this.id, kind: "increment", command: { actorId: this.id, type: "increment" } };
  }

  takeReasonerCallReports(context: { transactionId: string }): SocialReasonerCallReport[] {
    if (!this.report) return [];
    if (context.transactionId !== this.transactionId) throw new Error("transaction mismatch");
    return [structuredClone(this.report)];
  }
}

const adapter = {
  schemaVersion: "harness.domain-adapter.v1" as const,
  domainId: "counter-provider-evidence",
  adapterId: "counter.provider-evidence",
  adapterVersion: "1",
  semanticHash: hashStableState({ domain: "counter-provider-evidence", version: 1 }),
  components: [
    { kind: "agent_state_schema" as const, id: "counter.agent-state", version: "1", semanticHash: "counter-agent-state-v1" },
    { kind: "command_codec" as const, id: "counter.command", version: "1", semanticHash: "counter-command-v1" },
    { kind: "environment" as const, id: "counter.environment", version: "1", semanticHash: "counter-environment-v1" },
    { kind: "observation_projection" as const, id: "counter.observation", version: "1", semanticHash: "counter-observation-v1" },
    { kind: "scheduler" as const, id: "counter.scheduler", version: "1", semanticHash: "counter-scheduler-v1" }
  ]
};

function spec(reasoner: boolean, decisionTimeoutMs = 1_000) {
  return normalizeGenericExperimentSpec({
    id: `counter-provider-${reasoner ? "reasoner" : "policy"}`,
    kind: "episode",
    domainId: adapter.domainId,
    domainAdapter: adapter,
    seed: "counter-provider-seed",
    episodeCount: 1,
    actorCount: 1,
    schedulerMode: "aec",
    profiles: [{
      id: "counter-profile",
      version: "1",
      policyId: "counter.policy",
      ...(reasoner ? { reasonerId: "counter.reasoner" } : {})
    }],
    modelAssignments: reasoner ? [{ profileId: "counter-profile", modelId: "opaque-test-model" }] : [],
    assignmentPolicy: { id: "counter.assignment", version: "1" },
    maxTransitions: 1,
    timeoutPolicy: { id: "counter.timeout", version: "1", decisionTimeoutMs },
    retryPolicy: { id: "counter.retry", version: "1", maxAttempts: 1 },
    evaluatorIds: [],
    artifactPolicy: { id: "counter.artifact", version: "1", visibility: "research-full" },
    checkpointPolicy: { id: "counter.checkpoint", version: "1", mode: "none" },
    ...(reasoner ? { providerPolicy: { id: "counter.streaming", version: "1", stream: true as const } } : {}),
    continueOnError: false,
    domainConfig: {}
  });
}

const unusedFixtureClient: ModelClient = {
  async complete() {
    throw new Error("Provider client is not invoked by the counter actor fixture.");
  }
};

async function episode(input: { reasoner: boolean; report?: SocialReasonerCallReport; live?: boolean }) {
  const reasoner = input.reasoner
    ? input.live === false
      ? new OpenAIHarnessReasoner(unusedFixtureClient)
      : OpenAIHarnessReasoner.forLiveProvider(unusedFixtureClient)
    : undefined;
  return runHarnessEpisode({
    id: `counter-episode-${input.reasoner ? "reasoner" : "policy"}`,
    domainId: adapter.domainId,
    domainAdapter: adapter,
    environment: new CounterEnvironment(),
    actors: [new CounterActor({
      id: "counter-profile",
      version: "1",
      model: "opaque-test-model",
      policyId: "counter.policy",
      ...(input.reasoner ? { reasonerId: "counter.reasoner" } : {})
    }, input.report)],
    reasoner,
    schedulerMode: "aec",
    maxTransitions: 1,
    executionLimits: { decisionTimeoutMs: 1_000 }
  });
}

const completedStream: SocialReasonerCallReport = {
  outcome: "completed",
  latencyMs: 17,
  attempts: 2,
  usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  retryHistory: [{ attempt: 1, failureKind: "http", providerStage: "http_response", status: 429, retryable: true, delayMs: 5 }],
  stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
};

describe("generic provider/reasoner execution evidence", () => {
  it("lets the runner bind a streamed call to canonical actor, profile, model, and trace identity", async () => {
    const socialEpisode = await episode({ reasoner: true, report: completedStream });
    const normalized = spec(true);

    expect(validateSocialEpisodeArtifact(socialEpisode)).toEqual([]);
    expect(socialEpisode.execution?.reasonerExecutionClass).toBe("live-provider");
    expect(validateGenericExperimentExecutionEvidence(normalized, socialEpisode)).toEqual([]);
    const attestation = createGenericExperimentExecutionAttestation(normalized, socialEpisode);
    expect(attestation.reasonerCalls).toEqual([
      expect.objectContaining({
        schemaVersion: "harness.reasoner-call-evidence.v1",
        callId: `${socialEpisode.steps[0]!.traceId}:reasoner-call:1`,
        traceId: socialEpisode.steps[0]!.traceId,
        actorId: "counter",
        profileId: "counter-profile",
        model: "opaque-test-model",
        outcome: "completed",
        attempts: 2,
        stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
      })
    ]);
    expect(attestation.reasonerExecutionClass).toBe("live-provider");
    expect(JSON.stringify(attestation)).not.toMatch(/endpoint|apiKey|authorization|providerRequestId|requestBody/i);
  });

  it("accepts an assigned deterministic policy actor with zero provider calls", async () => {
    const socialEpisode = await episode({ reasoner: false });
    const normalized = spec(false);

    expect(socialEpisode.steps[0]!.reasonerCalls).toBeUndefined();
    expect(socialEpisode.execution?.reasonerExecutionClass).toBe("policy-only");
    expect(validateGenericExperimentExecutionEvidence(normalized, socialEpisode)).toEqual([]);
    expect(createGenericExperimentExecutionAttestation(normalized, socialEpisode)).not.toHaveProperty("reasonerCalls");
  });

  it("rejects fixture stream telemetry when the injected reasoner was not explicitly constructed as live", async () => {
    const socialEpisode = await episode({ reasoner: true, report: completedStream, live: false });
    const errors = validateGenericExperimentExecutionEvidence(spec(true), socialEpisode);

    expect(socialEpisode.execution?.reasonerExecutionClass).toBe("injected-unverified");
    expect(errors).toContain(
      "socialEpisode.execution.reasonerExecutionClass must be live-provider when experiment.spec.providerPolicy is present."
    );
    expect(() => createGenericExperimentExecutionAttestation(spec(true), socialEpisode)).toThrow(
      /reasonerExecutionClass must be live-provider/
    );
  });

  it("fails closed when a provider-backed reasoner decision omits call evidence", async () => {
    const socialEpisode = await episode({ reasoner: true });
    const normalized = spec(true);

    expect(validateGenericExperimentExecutionEvidence(normalized, socialEpisode)).toContain(
      "socialEpisode.steps[0] is missing runner-bound reasoner call evidence."
    );
    expect(() => createGenericExperimentExecutionAttestation(normalized, socialEpisode)).toThrow(/missing runner-bound reasoner call evidence/);
  });

  it("fails closed on a completed non-streaming call", async () => {
    const socialEpisode = await episode({
      reasoner: true,
      report: { ...completedStream, stream: { enabled: false, completed: true, completedBy: "reader_done" } }
    });
    const errors = validateGenericExperimentExecutionEvidence(spec(true), socialEpisode);

    expect(errors.some((error) => error.includes("stream.enabled must be true"))).toBe(true);
  });

  it("rejects post-run actor/model/trace forgery even when ordinary call fields remain valid", async () => {
    const socialEpisode = await episode({ reasoner: true, report: completedStream });
    const call = socialEpisode.steps[0]!.reasonerCalls![0]!;
    call.actorId = "forged-actor";
    call.model = "forged-model";
    call.traceId = "forged-trace";

    expect(validateSocialEpisodeArtifact(socialEpisode).join(" ")).toMatch(/actorId must match|model must match|traceId must match/);
    expect(() => createGenericExperimentExecutionAttestation(spec(true), socialEpisode)).toThrow(/execution evidence is invalid/);
  });

  it("does not invent a provider call when the decision budget expires before a report exists", async () => {
    const actor: SocialActor<{ count: number }, CounterPending, CounterCommand> = {
      id: "counter",
      profile: {
        id: "counter-profile",
        version: "1",
        model: "opaque-test-model",
        policyId: "counter.policy",
        reasonerId: "counter.reasoner"
      },
      observe() {},
      decide: () => new Promise(() => undefined)
    };
    const socialEpisode = await runHarnessEpisode({
      id: "counter-reasoner-timeout",
      domainId: adapter.domainId,
      domainAdapter: adapter,
      environment: new CounterEnvironment(),
      actors: [actor],
      reasoner: OpenAIHarnessReasoner.forLiveProvider(unusedFixtureClient),
      maxTransitions: 1,
      executionLimits: { decisionTimeoutMs: 1 }
    });

    const abortedActorStep = socialEpisode.steps.find((step) => step.actorId === "counter");
    expect(abortedActorStep).toMatchObject({
      commitStatus: "rejected",
      failure: { stage: "decision_timeout" }
    });
    expect(abortedActorStep?.reasonerCalls).toBeUndefined();
    expect(validateSocialEpisodeArtifact(socialEpisode)).toEqual([]);
    expect(validateGenericExperimentExecutionEvidence(spec(true, 1), socialEpisode)).toEqual([]);
  });

  it("does not invent a provider call when harness control aborts an in-flight decision", async () => {
    const controller = new AbortController();
    const actor: SocialActor<{ count: number }, CounterPending, CounterCommand> = {
      id: "counter",
      profile: {
        id: "counter-profile",
        version: "1",
        model: "opaque-test-model",
        policyId: "counter.policy",
        reasonerId: "counter.reasoner"
      },
      observe() {},
      decide() {
        controller.abort();
        return new Promise(() => undefined);
      }
    };
    const socialEpisode = await runHarnessEpisode({
      id: "counter-reasoner-abort",
      domainId: adapter.domainId,
      domainAdapter: adapter,
      environment: new CounterEnvironment(),
      actors: [actor],
      reasoner: OpenAIHarnessReasoner.forLiveProvider(unusedFixtureClient),
      maxTransitions: 1,
      executionLimits: { abortSignal: controller.signal, decisionTimeoutMs: 1_000 }
    });

    const abortedActorStep = socialEpisode.steps.find((step) => step.actorId === "counter");
    expect(abortedActorStep).toMatchObject({
      commitStatus: "rejected",
      failure: { stage: "batch_aborted" }
    });
    expect(abortedActorStep?.reasonerCalls).toBeUndefined();
    expect(socialEpisode.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: "system",
        failure: expect.objectContaining({ stage: "execution_abort" })
      })
    ]));
    expect(validateSocialEpisodeArtifact(socialEpisode)).toEqual([]);
    expect(validateGenericExperimentExecutionEvidence(spec(true), socialEpisode)).toEqual([]);
  });
});
