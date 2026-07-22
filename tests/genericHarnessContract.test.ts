import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runEvaluationRegistry } from "../src/harness/evaluation";
import { hashStableState } from "../src/harness/hash";
import {
  validateSocialDomainAdapterManifest,
  type SocialDomainAdapterManifest
} from "../src/harness/domainAdapter";
import {
  createGenericExperimentExecutionAttestation,
  createGenericExperimentProvenance,
  replaySocialEpisode,
  verifyHarnessEpisodeArtifact,
  type GenericExperimentSpecV1
} from "../src/harness/generic";
import { runHarnessEpisode } from "../src/harness/runner";
import { ScaffoldedSocialActor } from "../src/harness/scaffold";
import { createSocialStateEvaluator } from "../src/harness/socialEvaluator";
import { appendSocialMemory, createAgentSocialState, type AgentSocialState } from "../src/harness/socialState";
import {
  HarnessCheckpointSelectionError,
  buildHarnessCheckpointAtPrefix,
  compactRecordedSocialAgentSnapshots,
  createGenericForkProvenance,
  createHarnessAgentSnapshotFrameResolver,
  validateHarnessAgentSnapshotFrameRegistry,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope
} from "../src/harness/episodeArtifacts";
import { buildSocialCheckpointForkSeed, runForkedHarnessEpisode } from "../src/harness/checkpointRuntime";
import {
  runSocialEpisode,
  validateSocialEpisodeArtifact,
  type SocialAction,
  type SocialActor,
  type SocialActorStepReceipt,
  type SocialAgentProfile,
  type SocialChannel,
  type SocialEnvironment,
  type SocialParallelEnvironment,
  type SocialMessage
} from "../src/harness/social";

type LedgerActorId = "a" | "b" | "c";

interface LedgerState {
  turn: number;
  done: boolean;
  entries: string[];
  secrets: Record<LedgerActorId, string>;
}

interface LedgerPending {
  actorId: LedgerActorId;
  kind: "record";
}

interface LedgerObservation {
  agentId: LedgerActorId;
  pendingKind: "record";
  turn: number;
  privateToken: string;
  visibleMessages?: SocialMessage[];
  channels?: SocialChannel[];
}

interface LedgerCommand {
  actorId: LedgerActorId;
  entry: string;
}

interface LedgerSocialSnapshot {
  actorId: LedgerActorId;
  social: AgentSocialState<LedgerObservation, LedgerPending, LedgerCommand>;
}

type LedgerMessageDraft = NonNullable<SocialAction<LedgerCommand>["messages"]>[number];

const publicChannel: SocialChannel = {
  id: "public-ledger",
  kind: "public",
  participantIds: ["a", "b", "c"],
  readableBy: "all"
};

const privateABChannel: SocialChannel = {
  id: "private-a-b",
  kind: "private",
  participantIds: ["a", "b"],
  readableBy: "participants"
};

const ledgerDomainAdapter: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: "ledger",
  adapterId: "ledger.social",
  adapterVersion: "1",
  semanticHash: hashStableState({ adapter: "ledger.social", version: 1 }),
  components: [
    {
      kind: "agent_state_schema",
      id: "ledger.actor-state",
      version: "1",
      semanticHash: hashStableState({ stores: ["committedEntries"] })
    },
    {
      kind: "command_codec",
      id: "ledger.command",
      version: "1",
      semanticHash: hashStableState({ command: "record" })
    },
    {
      kind: "environment",
      id: "ledger.environment",
      version: "1",
      semanticHash: hashStableState({ order: "a-b-c" })
    },
    {
      kind: "observation_projection",
      id: "ledger.observation",
      version: "1",
      semanticHash: hashStableState({ privateToken: true })
    },
    {
      kind: "scheduler",
      id: "ledger.scheduler",
      version: "1",
      semanticHash: hashStableState({ modes: ["aec"] })
    }
  ]
};

function ledgerEpisodeExperiment(id: string, overrides: Partial<GenericExperimentSpecV1> = {}): GenericExperimentSpecV1 {
  return {
    id,
    kind: "episode",
    domainId: "ledger",
    domainAdapter: ledgerDomainAdapter,
    seed: `${id}:seed`,
    episodeCount: 1,
    actorCount: 1,
    schedulerMode: "aec",
    profiles: [{ id: "a", version: "1", policyId: "ledger.policy.local" }],
    modelAssignments: [],
    assignmentPolicy: { id: "ledger.assignment.fixed", version: "1", configuration: { actors: ["a"] } },
    maxTransitions: 1,
    timeoutPolicy: { id: "harness.timeout.local", version: "1", runTimeoutMs: 1_000 },
    retryPolicy: { id: "harness.retry.none", version: "1", maxAttempts: 1 },
    evaluatorIds: ["ledger.consistency.v1"],
    artifactPolicy: { id: "harness.artifact.research", version: "1", visibility: "research-full" },
    checkpointPolicy: { id: "harness.checkpoint.native", version: "1", mode: "native-boundaries" },
    continueOnError: false,
    domainConfig: { ledgerMode: "append-only" },
    ...overrides
  };
}

describe("generic social harness contract", () => {
  it("keeps the reusable runner, replay, checkpoint, and public barrel free of Werewolf/core imports", () => {
    const genericModulePaths = [
      "../src/harness/generic.ts",
      "../src/harness/runner.ts",
      "../src/harness/socialReplay.ts",
      "../src/harness/episodeArtifacts.ts",
      "../src/harness/checkpointRuntime.ts"
    ];
    for (const relativePath of genericModulePaths) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/core|\.\/environment|\.\/artifacts|\.\/werewolfAdapter|\.\.\/server|\.\.\/components)/);
    }
  });

  it("binds replay and checkpoint restoration to a versioned domain adapter before any environment mutation", async () => {
    expect(validateSocialDomainAdapterManifest(ledgerDomainAdapter)).toEqual([]);
    const agents = [{ id: "a", durableMemoryVersion: 1 }];
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-adapter-bound",
      domainAdapter: ledgerDomainAdapter,
      environment: new LedgerEnvironment({ actorIds: ["a"] }),
      actors: [
        new LedgerActor("a", () => ({
          actorId: "a",
          kind: "record",
          command: { actorId: "a", entry: "adapter-bound" }
        }))
      ],
      channels: [publicChannel],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => agents
    });

    expect(episode.domainId).toBe("ledger");
    expect(episode.domainAdapter).toEqual(ledgerDomainAdapter);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    const incompatibleAdapter = clone(ledgerDomainAdapter);
    incompatibleAdapter.semanticHash = hashStableState({ adapter: "ledger.social", version: 2 });
    const replayEnvironment = new LedgerEnvironment({ actorIds: ["a"] });
    const replay = replaySocialEpisode({
      episode,
      environment: replayEnvironment,
      hashState: hashStableState,
      hashMessages: hashStableState,
      domainAdapter: incompatibleAdapter
    });
    expect(replay.ok).toBe(false);
    expect(replay.mismatches.join(" ")).toMatch(/Domain adapter binding: .*does not exactly match/i);
    expect(replayEnvironment.stepCalls).toBe(0);

    const checkpoint = buildHarnessCheckpointAtPrefix<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, (typeof agents)[number]>({
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-adapter-bound-checkpoint",
      sourceArtifactVersion: "ledger.episode.v1",
      episode,
      selector: { nativeStepCount: 1 },
      recordedAgentState: {
        mode: "validate",
        validator: ({ agents: recordedAgents }) =>
          recordedAgents.some((agent) => !agent.id) ? ["ledger actor id is missing"] : []
      },
      replayPrefix: (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment({ actorIds: ["a"] }),
          hashState: hashStableState,
          hashMessages: hashStableState,
          domainAdapter: ledgerDomainAdapter,
          validateExpectedFinalState: false
        })
    });
    expect(checkpoint.source.domainAdapter).toEqual(ledgerDomainAdapter);
    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(buildSocialCheckpointForkSeed(checkpoint).forkOf.parentDomainAdapter).toEqual(ledgerDomainAdapter);

    const parentExperiment = createGenericExperimentProvenance(ledgerEpisodeExperiment("ledger-parent-experiment"));
    const childExperiment = createGenericExperimentProvenance(
      ledgerEpisodeExperiment("ledger-child-experiment", {
        seed: "ledger-counterfactual-seed",
        profiles: [
          { id: "a", version: "1", policyId: "ledger.policy.local" },
          { id: "ledger-counterfactual", version: "2", policyId: "ledger.policy.counterfactual" }
        ],
        domainConfig: { ledgerMode: "replace-only" }
      })
    );
    const experimentBoundCheckpoint = clone(checkpoint);
    experimentBoundCheckpoint.source.experiment = parentExperiment;
    expect(validateHarnessCheckpointEnvelope(experimentBoundCheckpoint)).toEqual([]);
    const experimentBoundFork = createGenericForkProvenance(experimentBoundCheckpoint, {
      createdAt: "2026-07-22T00:00:00.000Z",
      childExperiment,
      changedExperimentFields: [
        { field: "seed" },
        { field: "profiles" },
        { field: "domainConfig" },
        { field: "id" }
      ]
    });
    expect(experimentBoundFork.experimentLineage).toMatchObject({
      parent: { specHash: parentExperiment.specHash },
      child: { specHash: childExperiment.specHash },
      changedFields: [
        { field: "domainConfig" },
        { field: "id" },
        { field: "profiles" },
        { field: "seed" }
      ]
    });
    expect(() => buildSocialCheckpointForkSeed(experimentBoundCheckpoint)).toThrow(/requires both .* childExperiment/i);

    let verifierCalls = 0;
    let environmentRestores = 0;
    let actorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint,
        runtime: {
          recordedAgentState: { mode: "validate", validator: () => [] },
          domainAdapter: incompatibleAdapter,
          createEnvironment(initialState) {
            environmentRestores += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          restoreActors() {
            actorRestores += 1;
            return [];
          }
        },
        verifyCheckpointReplay: () => {
          verifierCalls += 1;
          return [];
        },
        episode: {
          id: "ledger-adapter-bound-forbidden-fork",
          domainAdapter: incompatibleAdapter,
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/Checkpoint adapter compatibility failed/i);
    expect(verifierCalls).toBe(0);
    expect(environmentRestores).toBe(0);
    expect(actorRestores).toBe(0);

    let inheritedVerifierCalls = 0;
    let inheritedEnvironmentRestores = 0;
    let inheritedActorRestores = 0;
    const inherited = await runForkedHarnessEpisode({
      checkpoint,
      runtime: {
        recordedAgentState: {
          mode: "validate",
          validator: (candidate) => candidate.agents.some((agent) => !agent.id) ? ["ledger actor id is missing"] : []
        },
        domainAdapter: ledgerDomainAdapter,
        createEnvironment(initialState) {
          inheritedEnvironmentRestores += 1;
          return new LedgerEnvironment({ initialState, actorIds: ["a"] });
        },
        restoreActors(agentStates) {
          inheritedActorRestores += 1;
          return agentStates.map(
            (agent) =>
              new LedgerActor(agent.id as LedgerActorId, () => ({
                actorId: agent.id as LedgerActorId,
                kind: "record",
                command: { actorId: agent.id as LedgerActorId, entry: "unused-after-terminal-checkpoint" }
              }))
          );
        }
      },
      verifyCheckpointReplay: (candidate) => {
        inheritedVerifierCalls += 1;
        return validateHarnessCheckpointReplay(candidate, (executionPrefix) =>
          replaySocialEpisode({
            episode: executionPrefix,
            environment: new LedgerEnvironment({ actorIds: ["a"] }),
            hashState: hashStableState,
            hashMessages: hashStableState,
            domainAdapter: ledgerDomainAdapter,
            auditAgentSnapshots: false
          })
        );
      },
      // Omission is intentional: an adapter-bound parent must inherit the
      // already verified runtime manifest instead of producing legacy truth.
      episode: {
        id: "ledger-adapter-bound-inherited-fork",
        maxTransitions: 1,
        hashState: hashStableState,
        hashMessages: hashStableState
      }
    });
    expect(inheritedVerifierCalls).toBe(1);
    expect(inheritedEnvironmentRestores).toBe(1);
    expect(inheritedActorRestores).toBe(1);
    expect(inherited.socialEpisode.domainAdapter).toEqual(ledgerDomainAdapter);
    expect(inherited.socialEpisode.domainId).toBe("ledger");
    expect(
      replaySocialEpisode({
        episode: inherited.socialEpisode,
        environment: new LedgerEnvironment({ initialState: inherited.socialEpisode.initialState, actorIds: ["a"] }),
        hashState: hashStableState,
        hashMessages: hashStableState
      }).mismatches.join(" ")
    ).toMatch(/runtime domainAdapter is required/i);

    const inheritedEnvelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: inherited.socialEpisode.id,
      createdAt: "2026-07-22T00:00:00.000Z",
      status: inherited.socialEpisode.status,
      initialState: inherited.socialEpisode.initialState,
      finalState: inherited.socialEpisode.finalState,
      socialEpisode: inherited.socialEpisode,
      agents,
      forkOf: inherited.seed.forkOf
    } satisfies HarnessEpisodeArtifactEnvelope<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, (typeof agents)[number]>;
    expect(validateHarnessEpisodeArtifactEnvelope(inheritedEnvelope)).toEqual([]);
    const experimentBoundEnvelope = {
      ...inheritedEnvelope,
      experiment: childExperiment,
      executionAttestation: createGenericExperimentExecutionAttestation(
        childExperiment.spec,
        inherited.socialEpisode
      ),
      forkOf: experimentBoundFork
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      (typeof agents)[number]
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(experimentBoundEnvelope)).toEqual([]);
    const missingExecutionAttestation = clone(experimentBoundEnvelope) as HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      (typeof agents)[number]
    >;
    delete missingExecutionAttestation.executionAttestation;
    expect(validateHarnessEpisodeArtifactEnvelope(missingExecutionAttestation).join(" ")).toMatch(
      /executionAttestation is required/i
    );
    const downgradedMissingExecutionAttestation = clone(missingExecutionAttestation);
    downgradedMissingExecutionAttestation.experiment!.schemaVersion = "harness.experiment-provenance.v1";
    delete downgradedMissingExecutionAttestation.experiment!.executionAttestationRequired;
    expect(validateHarnessEpisodeArtifactEnvelope(downgradedMissingExecutionAttestation).join(" ")).toMatch(
      /executionAttestation is required/i
    );
    const forgedExecutionBudget = clone(experimentBoundEnvelope);
    forgedExecutionBudget.socialEpisode.execution!.maxTransitions = 2;
    forgedExecutionBudget.executionAttestation.maxTransitions = 2;
    expect(validateHarnessEpisodeArtifactEnvelope(forgedExecutionBudget).join(" ")).toMatch(
      /execution\.maxTransitions must match experiment\.spec\.maxTransitions/i
    );
    const forgedDecisionBudget = clone(experimentBoundEnvelope);
    forgedDecisionBudget.socialEpisode.execution!.decisionTimeoutMs = 5_000;
    expect(validateHarnessEpisodeArtifactEnvelope(forgedDecisionBudget).join(" ")).toMatch(
      /execution\.decisionTimeoutMs must match experiment\.spec\.timeoutPolicy\.decisionTimeoutMs/i
    );
    const forgedRuntimeProfile = clone(experimentBoundEnvelope);
    forgedRuntimeProfile.socialEpisode.runtimeActors![0]!.profileVersion = "forged";
    forgedRuntimeProfile.socialEpisode.profiles[0]!.version = "forged";
    forgedRuntimeProfile.executionAttestation.actors[0]!.profile.version = "forged";
    expect(validateHarnessEpisodeArtifactEnvelope(forgedRuntimeProfile).join(" ")).toMatch(
      /profileVersion must match the selected experiment profile version/i
    );
    const forgedRuntimePolicy = clone(experimentBoundEnvelope);
    forgedRuntimePolicy.socialEpisode.runtimeActors![0]!.policyId = "forged.policy";
    forgedRuntimePolicy.socialEpisode.profiles[0]!.policyId = "forged.policy";
    forgedRuntimePolicy.executionAttestation.actors[0]!.profile.policyId = "forged.policy";
    expect(validateHarnessEpisodeArtifactEnvelope(forgedRuntimePolicy).join(" ")).toMatch(
      /policyId must match the selected experiment profile policyId/i
    );
    const forgedAttestation = clone(experimentBoundEnvelope);
    forgedAttestation.executionAttestation.specHash = "forged-spec-hash";
    expect(validateHarnessEpisodeArtifactEnvelope(forgedAttestation).join(" ")).toMatch(
      /executionAttestation must exactly match/i
    );
    const malformedRuntimeActors = clone(experimentBoundEnvelope) as unknown as Record<string, any>;
    malformedRuntimeActors.socialEpisode.runtimeActors = [null];
    expect(() => validateHarnessEpisodeArtifactEnvelope(malformedRuntimeActors as any)).not.toThrow();
    expect(validateHarnessEpisodeArtifactEnvelope(malformedRuntimeActors as any).join(" ")).toMatch(
      /runtimeActors\[0\] must be an object/i
    );
    const malformedRuntimeActorFields = clone(experimentBoundEnvelope) as unknown as Record<string, any>;
    malformedRuntimeActorFields.socialEpisode.runtimeActors = [{ actorId: 7, profileId: "a", model: {}, profileVersion: 1 }];
    expect(() => validateHarnessEpisodeArtifactEnvelope(malformedRuntimeActorFields as any)).not.toThrow();
    expect(validateHarnessEpisodeArtifactEnvelope(malformedRuntimeActorFields as any).join(" ")).toMatch(
      /runtimeActors\[0\].*(actorId|model|profileVersion)/i
    );
    const runtimeActorWithUnknownField = clone(experimentBoundEnvelope) as unknown as Record<string, any>;
    runtimeActorWithUnknownField.socialEpisode.runtimeActors[0].provider = "forged-provider";
    expect(validateHarnessEpisodeArtifactEnvelope(runtimeActorWithUnknownField as any).join(" ")).toMatch(
      /runtimeActors\[0\] contains unknown field.*provider/i
    );
    const nullExperimentEnvelope = clone(experimentBoundEnvelope) as unknown as Record<string, unknown>;
    nullExperimentEnvelope.experiment = null;
    expect(
      validateHarnessEpisodeArtifactEnvelope(nullExperimentEnvelope as unknown as typeof experimentBoundEnvelope).join(" ")
    ).toMatch(/experiment must be an object/i);
    const missingRosterEnvelope = clone(experimentBoundEnvelope);
    delete missingRosterEnvelope.socialEpisode.runtimeActorIds;
    expect(validateHarnessEpisodeArtifactEnvelope(missingRosterEnvelope).join(" ")).toMatch(/runtimeActorIds is required/i);
    const splitIdentityEnvelope = clone(experimentBoundEnvelope);
    splitIdentityEnvelope.runId = "different-outer-run";
    expect(validateHarnessEpisodeArtifactEnvelope(splitIdentityEnvelope).join(" ")).toMatch(/runId must match socialEpisode.id/i);
    const conflictingParentAdapterEnvelope = clone(experimentBoundEnvelope);
    conflictingParentAdapterEnvelope.forkOf.parentDomainAdapter = incompatibleAdapter;
    expect(validateHarnessEpisodeArtifactEnvelope(conflictingParentAdapterEnvelope).join(" ")).toMatch(
      /parentDomainAdapter.*does not exactly match.*experimentLineage\.parent\.spec\.domainAdapter/i
    );
    const nullCheckpointExperiment = clone(experimentBoundCheckpoint) as unknown as Record<string, unknown>;
    (nullCheckpointExperiment.source as Record<string, unknown>).experiment = null;
    expect(
      validateHarnessCheckpointEnvelope(nullCheckpointExperiment as unknown as typeof experimentBoundCheckpoint).join(" ")
    ).toMatch(/source\.experiment must be an object/i);
    const forgedCheckpointBudget = clone(experimentBoundCheckpoint);
    forgedCheckpointBudget.executionPrefix.execution!.maxTransitions = 2;
    forgedCheckpointBudget.source.executionPrefixHash = hashStableState(forgedCheckpointBudget.executionPrefix);
    expect(validateHarnessCheckpointEnvelope(forgedCheckpointBudget).join(" ")).toMatch(
      /executionPrefix\.execution\.maxTransitions must match experiment\.spec\.maxTransitions/i
    );
    const downgradedForgedCheckpoint = clone(forgedCheckpointBudget);
    downgradedForgedCheckpoint.source.experiment!.schemaVersion = "harness.experiment-provenance.v1";
    delete downgradedForgedCheckpoint.source.experiment!.executionAttestationRequired;
    expect(validateHarnessCheckpointEnvelope(downgradedForgedCheckpoint).join(" ")).toMatch(
      /executionPrefix\.execution\.maxTransitions must match experiment\.spec\.maxTransitions/i
    );
    const forgedCheckpointTimeout = clone(experimentBoundCheckpoint);
    forgedCheckpointTimeout.executionPrefix.execution!.decisionTimeoutMs = 123;
    forgedCheckpointTimeout.source.executionPrefixHash = hashStableState(forgedCheckpointTimeout.executionPrefix);
    expect(validateHarnessCheckpointEnvelope(forgedCheckpointTimeout).join(" ")).toMatch(
      /executionPrefix\.execution\.decisionTimeoutMs must match experiment\.spec\.timeoutPolicy\.decisionTimeoutMs/i
    );
    const forgedCheckpointProfile = clone(experimentBoundCheckpoint);
    forgedCheckpointProfile.executionPrefix.runtimeActors![0]!.profileVersion = "forged";
    forgedCheckpointProfile.executionPrefix.profiles[0]!.version = "forged";
    forgedCheckpointProfile.source.executionPrefixHash = hashStableState(forgedCheckpointProfile.executionPrefix);
    expect(validateHarnessCheckpointEnvelope(forgedCheckpointProfile).join(" ")).toMatch(
      /profileVersion must match the selected experiment profile version/i
    );
    let forgedCheckpointVerifierCalls = 0;
    let forgedCheckpointEnvironmentRestores = 0;
    let forgedCheckpointActorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: downgradedForgedCheckpoint,
        runtime: {
          recordedAgentState: { mode: "validate", validator: () => [] },
          domainAdapter: ledgerDomainAdapter,
          createEnvironment(initialState) {
            forgedCheckpointEnvironmentRestores += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          restoreActors() {
            forgedCheckpointActorRestores += 1;
            return [];
          }
        },
        verifyCheckpointReplay: () => {
          forgedCheckpointVerifierCalls += 1;
          return [];
        },
        episode: {
          id: "forged-experiment-checkpoint",
          maxTransitions: 1,
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/Invalid harness checkpoint.*maxTransitions/i);
    expect(forgedCheckpointVerifierCalls).toBe(0);
    expect(forgedCheckpointEnvironmentRestores).toBe(0);
    expect(forgedCheckpointActorRestores).toBe(0);
    let experimentVerificationFactories = 0;
    expect(
      verifyHarnessEpisodeArtifact({
        artifact: experimentBoundEnvelope,
        runtime: {
          domainAdapter: ledgerDomainAdapter,
          createEnvironment(initialState) {
            experimentVerificationFactories += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          hashState: hashStableState,
          hashMessages: hashStableState,
          validateRecordedStep: () => [],
          recordedAgentState: { mode: "validate", validator: () => [] }
        }
      }).ok
    ).toBe(true);
    expect(experimentVerificationFactories).toBe(1);

    const forgedExperimentEnvelope = clone(experimentBoundEnvelope);
    forgedExperimentEnvelope.experiment.spec.seed = "forged-without-rehash";
    experimentVerificationFactories = 0;
    const forgedExperimentResult = verifyHarnessEpisodeArtifact({
      artifact: forgedExperimentEnvelope,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment(initialState) {
          experimentVerificationFactories += 1;
          return new LedgerEnvironment({ initialState, actorIds: ["a"] });
        },
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "validate", validator: () => [] }
      }
    });
    expect(forgedExperimentResult.ok).toBe(false);
    expect(forgedExperimentResult.structureErrors.join(" ")).toMatch(/experiment\.specHash does not match/i);
    expect(experimentVerificationFactories).toBe(0);
    const forgedSchedulerEnvelope = clone(experimentBoundEnvelope);
    forgedSchedulerEnvelope.socialEpisode.schedulerMode = "parallel";
    expect(validateHarnessEpisodeArtifactEnvelope(forgedSchedulerEnvelope).join(" ")).toMatch(
      /experiment\.spec\.schedulerMode must match socialEpisode\.schedulerMode/i
    );
    const forgedLegacyFork = clone(inheritedEnvelope);
    delete forgedLegacyFork.socialEpisode.domainAdapter;
    delete forgedLegacyFork.socialEpisode.domainId;
    expect(validateHarnessEpisodeArtifactEnvelope(forgedLegacyFork).join(" ")).toMatch(
      /socialEpisode\.domainAdapter is required when forkOf records parent adapter provenance/i
    );

    const malformed = clone(ledgerDomainAdapter) as SocialDomainAdapterManifest;
    malformed.components = [...malformed.components].reverse();
    expect(validateSocialDomainAdapterManifest(malformed).join(" ")).toMatch(/sorted canonically/i);
  });

  it("keeps environment observations scoped, delivers messages by channel visibility, and replays a non-Werewolf episode", async () => {
    const actorA = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "opening" },
      messages: [
        message("public-ledger", "a", ["a", "b", "c"], "public", "A opens the ledger"),
        message("private-a-b", "a", ["b"], "private", "B receives a private token hint")
      ]
    }));
    const actorB = new LedgerActor("b", () => ({
      actorId: "b",
      kind: "record",
      command: { actorId: "b", entry: "reply" }
    }));
    const actorC = new LedgerActor("c", () => ({
      actorId: "c",
      kind: "record",
      command: { actorId: "c", entry: "close" }
    }));

    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scoped-observation",
      environment: new LedgerEnvironment(),
      actors: [actorA, actorB, actorC],
      channels: [publicChannel, privateABChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    expect(episode.status).toBe("completed");
    expect(episode.finalState).toMatchObject({
      turn: 3,
      done: true,
      entries: ["a:opening", "b:reply", "c:close"]
    });
    expect(episode.steps.every((step) => step.commitStatus === "committed")).toBe(true);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    expect(actorA.observations).toEqual([
      expect.objectContaining({ agentId: "a", privateToken: "token-a", visibleMessages: [] })
    ]);
    expect(actorB.observations).toEqual([
      expect.objectContaining({ agentId: "b", privateToken: "token-b" })
    ]);
    expect(actorC.observations).toEqual([
      expect.objectContaining({ agentId: "c", privateToken: "token-c" })
    ]);
    expect(actorB.observations[0]?.visibleMessages?.map((entry) => entry.content)).toEqual([
      "A opens the ledger",
      "B receives a private token hint"
    ]);
    expect(actorC.observations[0]?.visibleMessages?.map((entry) => entry.content)).toEqual(["A opens the ledger"]);
    expect(actorB.observations[0]?.channels?.map((channel) => channel.id)).toEqual(
      expect.arrayContaining(["public-ledger", "private-a-b"])
    );
    expect(actorC.observations[0]?.channels?.map((channel) => channel.id)).toEqual(["public-ledger"]);
    expect(actorC.observations[0]?.visibleMessages?.some((entry) => entry.channelId === "private-a-b")).toBe(false);

    const replay = replaySocialEpisode({
      episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });

    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedSteps).toBe(3);
    expect(replay.finalHash).toBe(hashStableState(episode.finalState));
    expect(replay.messages).toEqual(episode.messages);
  });

  it("fails a rehashed non-Werewolf social snapshot when its new evidence was never scoped to that actor", async () => {
    const snapshots: LedgerSocialSnapshot[] = (["a", "b", "c"] as const).map((actorId) => ({
      actorId,
      social: createAgentSocialState<LedgerObservation, LedgerPending, LedgerCommand>({
        agentId: actorId,
        profile: { id: `ledger-social-${actorId}`, model: `deterministic-${actorId}`, policyId: "ledger-social" }
      })
    }));
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, LedgerSocialSnapshot>({
      id: "ledger-replay-social-state-semantics",
      domainAdapter: ledgerDomainAdapter,
      environment: new LedgerEnvironment(),
      actors: [
        new LedgerActor("a", () => ({
          actorId: "a",
          kind: "record",
          command: { actorId: "a", entry: "opening" },
          messages: [message("private-a-b", "a", ["b"], "private", "private ledger evidence")]
        })),
        new LedgerActor("b", () => ({
          actorId: "b",
          kind: "record",
          command: { actorId: "b", entry: "reply" }
        })),
        new LedgerActor("c", () => ({
          actorId: "c",
          kind: "record",
          command: { actorId: "c", entry: "close" }
        }))
      ],
      channels: [publicChannel, privateABChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => snapshots,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });
    const forged = clone(episode);
    const privateMessage = forged.messages.find((candidate) => candidate.channelId === privateABChannel.id);
    const forgedBoundary = forged.steps[1];
    const forgedC = forgedBoundary?.actorSnapshotsAfterStep?.find(
      (candidate): candidate is LedgerSocialSnapshot =>
        Boolean(candidate && typeof candidate === "object" && (candidate as { actorId?: unknown }).actorId === "c")
    );
    expect(privateMessage).toBeDefined();
    expect(forgedBoundary).toBeDefined();
    expect(forgedC).toBeDefined();
    appendSocialMemory(forgedC!.social, {
      kind: "message",
      source: "a",
      visibility: "private",
      content: "forged private-message memory",
      evidenceRefs: [{ artifact: "message", id: privateMessage!.id, seq: privateMessage!.seq }],
      tags: ["forged"]
    }, {
      traceId: forgedBoundary!.traceId,
      turnIndex: forgedBoundary!.turnIndex,
      messageSeqRange: { start: privateMessage!.seq, end: privateMessage!.seq }
    });
    forgedBoundary!.actorSnapshotsHashAfterStep = hashStableState(forgedBoundary!.actorSnapshotsAfterStep);

    // The hash-only audit remains intentionally agnostic about a domain's
    // social semantics. Once an attacker recomputes the snapshot hash, the
    // normal environment/message replay still succeeds.
    const structurallyConsistent = replaySocialEpisode({
      episode: forged,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      domainAdapter: ledgerDomainAdapter
    });
    expect(structurallyConsistent.ok).toBe(true);
    expect(structurallyConsistent.agentStateAudit?.ok).toBe(true);

    const validateScopedSocialState = (input: {
      priorAgents?: readonly LedgerSocialSnapshot[];
      recordedAgents: readonly LedgerSocialSnapshot[];
      committedMessages: readonly SocialMessage[];
      scopedExposureRecords: ReadonlyArray<{ observerId: string; messageId: string; messageSeq: number }>;
    }): string[] => {
      if (!input.priorAgents) return [];
      const priorJournalSeqs = new Map(
        input.priorAgents.map((agent) => [agent.actorId, new Set(agent.social.journal?.entries.map((entry) => entry.journalSeq) ?? [])])
      );
      const mismatches: string[] = [];
      for (const agent of input.recordedAgents) {
        const prior = priorJournalSeqs.get(agent.actorId) ?? new Set<number>();
        for (const entry of agent.social.journal?.entries ?? []) {
          if (prior.has(entry.journalSeq)) continue;
          for (const evidence of entry.evidenceRefs.filter((ref) => ref.artifact === "message")) {
            const message = input.committedMessages.find(
              (candidate) =>
                (evidence.id === undefined || candidate.id === evidence.id) &&
                (evidence.seq === undefined || candidate.seq === evidence.seq)
            );
            if (!message) {
              mismatches.push(`actor ${agent.actorId} cites a missing message evidence reference.`);
              continue;
            }
            const selfAuthored = message.senderId === agent.actorId;
            const scopedExposure = input.scopedExposureRecords.some(
              (exposure) =>
                exposure.observerId === agent.actorId &&
                exposure.messageId === message.id &&
                exposure.messageSeq === message.seq
            );
            if (!selfAuthored && !scopedExposure) {
              mismatches.push(`actor ${agent.actorId} cites message evidence outside its scoped observation.`);
            }
          }
        }
      }
      return mismatches;
    };

    const semanticReplay = replaySocialEpisode({
      episode: forged,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      domainAdapter: ledgerDomainAdapter,
      validateRecordedAgentState: validateScopedSocialState
    });
    expect(semanticReplay.ok).toBe(false);
    expect(semanticReplay.mismatches.join(" ")).toMatch(/Recorded agent state semantic audit.*actor c cites message evidence outside its scoped observation/i);

    const compacted = compactRecordedSocialAgentSnapshots<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, LedgerSocialSnapshot>({
      episode: forged
    });
    const compactedSemanticReplay = replaySocialEpisode({
      episode: compacted.episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      agentSnapshotFrames: compacted.frames,
      domainAdapter: ledgerDomainAdapter,
      validateRecordedAgentState: validateScopedSocialState
    });
    expect(compactedSemanticReplay.ok).toBe(false);
    expect(compactedSemanticReplay.mismatches.join(" ")).toMatch(/actor c cites message evidence outside its scoped observation/i);

    const finalForgedAgents = forged.steps.at(-1)?.actorSnapshotsAfterStep as LedgerSocialSnapshot[] | undefined;
    if (!finalForgedAgents) throw new Error("Expected final forged ledger snapshots.");
    const forgedEnvelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: forged.id,
      createdAt: "2026-07-22T12:00:00.000Z",
      status: forged.status,
      initialState: forged.initialState,
      finalState: forged.finalState,
      socialEpisode: forged,
      agents: finalForgedAgents
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerSocialSnapshot
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(forgedEnvelope)).toEqual([]);

    let rejectedVerificationEnvironmentFactories = 0;
    const implicitSemanticOptOut = verifyHarnessEpisodeArtifact({
      artifact: forgedEnvelope,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment() {
          rejectedVerificationEnvironmentFactories += 1;
          return new LedgerEnvironment();
        },
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "none", reason: "forged opt-out must fail" }
      }
    });
    expect(implicitSemanticOptOut.ok).toBe(false);
    expect(implicitSemanticOptOut.mismatches.join(" ")).toMatch(
      /mode=none is not allowed because the artifact records durable actor state/i
    );
    expect(rejectedVerificationEnvironmentFactories).toBe(0);

    const mismatchedVerificationAdapter = clone(ledgerDomainAdapter);
    mismatchedVerificationAdapter.components[0]!.semanticHash = hashStableState({ incompatible: true });
    let mismatchedVerificationEnvironmentFactories = 0;
    const adapterMismatch = verifyHarnessEpisodeArtifact({
      artifact: forgedEnvelope,
      runtime: {
        domainAdapter: mismatchedVerificationAdapter,
        createEnvironment() {
          mismatchedVerificationEnvironmentFactories += 1;
          return new LedgerEnvironment();
        },
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }
    });
    expect(adapterMismatch.ok).toBe(false);
    expect(adapterMismatch.mismatches.join(" ")).toMatch(/domain adapter binding/i);
    expect(mismatchedVerificationEnvironmentFactories).toBe(0);

    const verifiedForgedArtifact = verifyHarnessEpisodeArtifact({
      artifact: forgedEnvelope,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => new LedgerEnvironment(),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }
    });
    expect(verifiedForgedArtifact.ok).toBe(false);
    expect(verifiedForgedArtifact.validationMode).toBe("validate");
    expect(verifiedForgedArtifact.mismatches.join(" ")).toMatch(
      /Recorded agent state semantic audit.*actor c cites message evidence outside its scoped observation/i
    );

    const cleanFinalAgents = episode.steps.at(-1)?.actorSnapshotsAfterStep as LedgerSocialSnapshot[] | undefined;
    if (!cleanFinalAgents) throw new Error("Expected final clean ledger snapshots.");
    const cleanEnvelope = {
      ...forgedEnvelope,
      runId: episode.id,
      socialEpisode: episode,
      initialState: episode.initialState,
      finalState: episode.finalState,
      status: episode.status,
      agents: cleanFinalAgents
    };
    const cleanFirstCommand = clone(cleanEnvelope.socialEpisode.steps[0]!.action.command);
    const verifiedCleanArtifact = verifyHarnessEpisodeArtifact({
      artifact: cleanEnvelope,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => new LedgerEnvironment(),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep(step) {
          step.action.command = { actorId: "a", entry: "validator-mutation-must-not-escape" };
          return [];
        },
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }
    });
    expect(verifiedCleanArtifact).toMatchObject({
      ok: true,
      validationMode: "validate",
      structureErrors: [],
      configurationErrors: [],
      mismatches: []
    });
    expect(cleanEnvelope.socialEpisode.steps[0]!.action.command).toEqual(cleanFirstCommand);

    for (const [label, incompleteRuntime] of [
      ["validateRecordedStep", {
        domainAdapter: ledgerDomainAdapter,
        hashState: hashStableState,
        hashMessages: hashStableState,
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }],
      ["recordedAgentState", {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => new LedgerEnvironment(),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => []
      }],
      ["recordedAgentState.validator", {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => new LedgerEnvironment(),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "validate" }
      }]
    ] as const) {
      let incompleteFactoryCalls = 0;
      const runtime = {
        createEnvironment: () => {
          incompleteFactoryCalls += 1;
          return new LedgerEnvironment();
        },
        ...incompleteRuntime
      };
      const result = verifyHarnessEpisodeArtifact({
        artifact: cleanEnvelope,
        runtime
      } as unknown as Parameters<typeof verifyHarnessEpisodeArtifact>[0]);
      expect(result.ok, label).toBe(false);
      expect(result.configurationErrors.join(" "), label).toMatch(new RegExp(label.replace(".", "\\."), "i"));
      expect(incompleteFactoryCalls, label).toBe(0);
    }

    const missingBoundarySnapshot = clone(cleanEnvelope);
    delete missingBoundarySnapshot.socialEpisode.steps[1]!.actorSnapshotsAfterStep;
    delete missingBoundarySnapshot.socialEpisode.steps[1]!.actorSnapshotsHashAfterStep;
    expect(validateHarnessEpisodeArtifactEnvelope(missingBoundarySnapshot)).toEqual([]);
    let missingBoundaryFactoryCalls = 0;
    const missingBoundaryResult = verifyHarnessEpisodeArtifact({
      artifact: missingBoundarySnapshot,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => {
          missingBoundaryFactoryCalls += 1;
          return new LedgerEnvironment();
        },
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: () => [],
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }
    });
    expect(missingBoundaryResult.ok).toBe(false);
    expect(missingBoundaryResult.mismatches.join(" ")).toMatch(/committed actor receipt boundary is missing/i);
    expect(missingBoundaryFactoryCalls).toBe(0);

    const throwingValidator = verifyHarnessEpisodeArtifact({
      artifact: cleanEnvelope,
      runtime: {
        domainAdapter: ledgerDomainAdapter,
        createEnvironment: () => new LedgerEnvironment(),
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep() {
          throw new Error("private validator implementation detail");
        },
        recordedAgentState: { mode: "validate", validator: validateScopedSocialState }
      }
    });
    expect(throwingValidator.ok).toBe(false);
    expect(throwingValidator.mismatches.join(" ")).toMatch(/recorded pending\/action validator failed/i);
    expect(throwingValidator.mismatches.join(" ")).not.toContain("private validator implementation detail");
  });

  it("audits one receipt-after snapshot boundary for a complete parallel batch", async () => {
    const snapshots = [
      { id: "a", durableMemoryVersion: 1 },
      { id: "b", durableMemoryVersion: 1 }
    ];
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, (typeof snapshots)[number]>({
      id: "ledger-parallel-semantic-snapshot-boundary",
      environment: new ParallelLedgerEnvironment(),
      actors: [
        new LedgerActor("a", () => ({ actorId: "a", kind: "record", command: { actorId: "a", entry: "a-parallel" } })),
        new LedgerActor("b", () => ({ actorId: "b", kind: "record", command: { actorId: "b", entry: "b-parallel" } }))
      ],
      channels: [publicChannel],
      schedulerMode: "parallel",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => snapshots
    });
    const boundaries: Array<{ batchSize: number; actorIds: string[]; beforeEntries: string[]; afterEntries: string[] }> = [];
    const replay = replaySocialEpisode({
      episode,
      environment: new ParallelLedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      validateRecordedAgentState(input) {
        boundaries.push({
          batchSize: input.batch.length,
          actorIds: input.batch.map((step) => step.actorId),
          beforeEntries: input.stateBefore.entries,
          afterEntries: input.stateAfter.entries
        });
        return [];
      }
    });
    expect(replay.ok).toBe(true);
    expect(boundaries).toEqual([
      {
        batchSize: 2,
        actorIds: ["a", "b"],
        beforeEntries: [],
        afterEntries: ["a:a-parallel", "b:b-parallel"]
      }
    ]);
  });

  it("records typed statement attributions in a non-Werewolf actor snapshot without replay-time inference", async () => {
    const speaker = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "typed-statement" },
      messages: [
        message("public-ledger", "a", ["a", "b", "c"], "public", "opaque typed vote intent", [
          {
            id: "ledger-vote-intent",
            kind: "vote_intent",
            targetId: "c",
            value: "ledger-target-c",
            confidence: 0.9,
            evidenceRefs: []
          }
        ])
      ]
    }));
    const observer = new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
      id: "b",
      profile: { id: "ledger-observer-b", model: "deterministic-b", policyId: "ledger-policy" },
      policy: {
        id: "ledger-policy",
        decide(input) {
          return {
            actorId: input.agent.id as LedgerActorId,
            kind: "record",
            command: { actorId: input.agent.id as LedgerActorId, entry: "observer-commit" }
          };
        }
      }
    });
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-theory-of-mind",
      environment: new LedgerEnvironment({ actorIds: ["a", "b"] }),
      actors: [speaker, observer],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const attribution = observer.state.social.theoryOfMind?.records[
      "msg-1:speech-act:ledger-vote-intent:theory-of-mind"
    ];
    expect(attribution).toMatchObject({
      observerId: "b",
      subjectId: "a",
      kind: "stated_intent",
      proposition: { predicate: "vote_intent", targetId: "c", value: "ledger-target-c" },
      sourceMessageId: "msg-1",
      sourceMessageSeq: 1,
      sourceSpeechActId: "ledger-vote-intent",
      sourceDeliveryReceiptId: "msg-1:delivery:2:b",
      visibility: "public"
    });
    expect(observer.state.social.beliefs.claims).toEqual({});
    expect(observer.state.social.journal?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "theoryOfMind",
          mutationKind: "theory_of_mind.attribution.recorded",
          hiddenTruthUsed: false
        })
      ])
    );

    const replay = replaySocialEpisode({
      episode,
      environment: new LedgerEnvironment({ actorIds: ["a", "b"] }),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
  });

  it("records a non-Werewolf episode and checkpoint through the generic artifact envelope", async () => {
    const agents = [{ id: "a", durableMemoryVersion: 1 }];
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-generic-artifact-envelope",
      environment: new LedgerEnvironment({ actorIds: ["a"] }),
      actors: [
        new LedgerActor("a", () => ({
          actorId: "a",
          kind: "record",
          command: { actorId: "a", entry: "checkpoint-proof" }
        }))
      ],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => agents,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const envelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: "ledger-generic-artifact-envelope",
      createdAt: "2026-07-20T00:00:00.000Z",
      status: episode.status,
      initialState: episode.initialState,
      finalState: episode.finalState,
      socialEpisode: episode,
      agents
    } satisfies HarnessEpisodeArtifactEnvelope<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, (typeof agents)[number]>;
    expect(validateHarnessEpisodeArtifactEnvelope(envelope)).toEqual([]);

    const lastStep = episode.steps.at(-1);
    if (!lastStep) throw new Error("Expected ledger episode to record one native step.");
    const checkpoint = {
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-checkpoint-1",
      createdAt: "2026-07-20T00:00:01.000Z",
      source: {
        sourceArtifactVersion: envelope.artifactVersion,
        runId: envelope.runId,
        status: episode.status,
        boundaryTraceId: lastStep.traceId,
        boundaryTurnIndex: lastStep.turnIndex,
        boundaryBatchId: lastStep.batchId,
        boundaryBatchIndex: lastStep.batchIndex,
        boundarySchedulerMode: lastStep.schedulerMode,
        nativeStepCount: episode.steps.length,
        messageCount: episode.messages.length,
        lastMessageSeq: episode.messages.at(-1)?.seq,
        stateHash: hashStableState(episode.finalState),
        executionPrefixHash: hashStableState(episode),
        agentsHash: hashStableState(agents),
        channelsHash: hashStableState(episode.channels),
        messagesHash: hashStableState(episode.messages)
      },
      state: episode.finalState,
      agents,
      executionPrefix: episode
    } satisfies HarnessCheckpointEnvelope<LedgerState, (typeof agents)[number], LedgerObservation, LedgerPending, LedgerCommand>;

    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(
      validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment({ actorIds: ["a"] }),
          hashState: hashStableState,
          hashMessages: hashStableState
        })
      )
    ).toEqual([]);

    const tampered = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    tampered.source.messagesHash = "tampered";
    expect(validateHarnessCheckpointEnvelope(tampered).join(" ")).toMatch(/source\.messagesHash mismatch/);

    const forgedActorState = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    forgedActorState.agents = [{ id: "forged", durableMemoryVersion: 999 }];
    forgedActorState.source.agentsHash = hashStableState(forgedActorState.agents);
    expect(validateHarnessCheckpointEnvelope(forgedActorState).join(" ")).toMatch(/does not match final boundary actor snapshot hash/i);

    let environmentRestores = 0;
    let actorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: forgedActorState,
        runtime: {
          recordedAgentState: { mode: "validate", validator: () => [] },
          createEnvironment(initialState) {
            environmentRestores += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          restoreActors(agentStates) {
            actorRestores += 1;
            return agentStates.map((agent) => new LedgerActor(agent.id as LedgerActorId, () => ({
              actorId: agent.id as LedgerActorId,
              kind: "record",
              command: { actorId: agent.id as LedgerActorId, entry: "forbidden" }
            })));
          }
        },
        verifyCheckpointReplay: () => [],
        episode: {
          id: "ledger-forged-checkpoint-fork",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/final boundary actor snapshot hash/i);
    expect(environmentRestores).toBe(0);
    expect(actorRestores).toBe(0);

    // A failed/rejected record may retain a snapshot as failure evidence, but
    // it is never an actor-state restoration boundary. This construction is
    // structurally self-consistent under the persistence exception for failed
    // trajectories, so the fork guard itself must reject it before invoking a
    // verifier, environment factory, or actor restore factory.
    const rejectedBoundarySnapshot = clone(checkpoint);
    const rejectedBoundary = rejectedBoundarySnapshot.executionPrefix.steps.at(-1);
    if (!rejectedBoundary) throw new Error("Expected a checkpoint boundary step.");
    rejectedBoundary.commitStatus = "rejected";
    rejectedBoundary.error = "forged rejected boundary";
    rejectedBoundary.failure = { stage: "environment_step", message: "forged rejected boundary" };
    rejectedBoundary.postStateHash = rejectedBoundary.preStateHash;
    rejectedBoundarySnapshot.executionPrefix.status = "failed";
    rejectedBoundarySnapshot.executionPrefix.failureReason = "forged rejected boundary";
    rejectedBoundarySnapshot.executionPrefix.finalState = clone(rejectedBoundarySnapshot.executionPrefix.initialState);
    rejectedBoundarySnapshot.source.status = "failed";
    rejectedBoundarySnapshot.state = clone(rejectedBoundarySnapshot.executionPrefix.initialState);
    rejectedBoundarySnapshot.source.stateHash = hashStableState(rejectedBoundarySnapshot.state);
    rejectedBoundarySnapshot.source.executionPrefixHash = hashStableState(rejectedBoundarySnapshot.executionPrefix);
    expect(validateHarnessCheckpointEnvelope(rejectedBoundarySnapshot)).toEqual([]);
    expect(() => buildSocialCheckpointForkSeed(rejectedBoundarySnapshot)).toThrow(/final native boundary was rejected/i);

    let rejectedSnapshotResolutions = 0;
    let rejectedPrefixReplays = 0;
    expect(() =>
      buildHarnessCheckpointAtPrefix<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, { id: string; durableMemoryVersion: number }>({
        artifactVersion: "ledger.checkpoint.v1",
        kind: "ledger-checkpoint",
        checkpointId: "ledger-rejected-boundary-prefix",
        createdAt: "2026-07-22T00:00:00.000Z",
        sourceArtifactVersion: "ledger.episode.v1",
        episode: rejectedBoundarySnapshot.executionPrefix,
        selector: { nativeStepCount: 1 },
        recordedAgentState: {
          mode: "validate",
          validator: () => []
        },
        resolveAgentSnapshot: () => {
          rejectedSnapshotResolutions += 1;
          return {
            agents: [{ id: "a", durableMemoryVersion: 999 }],
            agentsHash: hashStableState([{ id: "a", durableMemoryVersion: 999 }])
          };
        },
        replayPrefix: () => {
          rejectedPrefixReplays += 1;
          return {
            mismatches: [],
            finalState: clone(rejectedBoundarySnapshot.executionPrefix.initialState)
          };
        }
      })
    ).toThrow(/no durable agent snapshot exists after a rejected boundary/i);
    expect(rejectedSnapshotResolutions).toBe(0);
    expect(rejectedPrefixReplays).toBe(0);

    let rejectedEnvironmentRestores = 0;
    let rejectedActorRestores = 0;
    let rejectedReplayVerifications = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: rejectedBoundarySnapshot,
        runtime: {
          recordedAgentState: { mode: "validate", validator: () => [] },
          createEnvironment(initialState) {
            rejectedEnvironmentRestores += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          restoreActors(agentStates) {
            rejectedActorRestores += 1;
            return agentStates.map((agent) => new LedgerActor(agent.id as LedgerActorId, () => ({
              actorId: agent.id as LedgerActorId,
              kind: "record",
              command: { actorId: agent.id as LedgerActorId, entry: "forbidden" }
            })));
          }
        },
        verifyCheckpointReplay: () => {
          rejectedReplayVerifications += 1;
          return [];
        },
        episode: {
          id: "ledger-rejected-boundary-fork",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/final native boundary was rejected/i);
    expect(rejectedReplayVerifications).toBe(0);
    expect(rejectedEnvironmentRestores).toBe(0);
    expect(rejectedActorRestores).toBe(0);
  });

  it("builds a generic native-prefix checkpoint, replays it without actors, and executes a restored non-Werewolf fork", async () => {
    const parentActors = new Map<LedgerActorId, CheckpointLedgerActor>(
      (["a", "b", "c"] as LedgerActorId[]).map((id) => [id, new CheckpointLedgerActor(id, `parent-${id}`)])
    );
    const parent = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-generic-prefix-parent",
      environment: new LedgerEnvironment(),
      actors: [...parentActors.values()],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => [...parentActors.values()].map((actor) => actor.snapshot())
    });
    const parentReplay = replaySocialEpisode({
      episode: parent,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(parentReplay.ok).toBe(true);
    expect(parentReplay.agentStateAudit).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3 });

    const compacted = compactRecordedSocialAgentSnapshots<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >({ episode: parent });
    const parentAgentStates = [...parentActors.values()].map((actor) => actor.snapshot());
    expect(parent.steps.every((step) => Array.isArray(step.actorSnapshotsAfterStep))).toBe(true);
    expect(compacted.episode.steps.every((step) => step.actorSnapshotsAfterStep === undefined)).toBe(true);
    expect(compacted.episode.steps.every((step) => Boolean(step.actorSnapshotsHashAfterStep && step.actorSnapshotFrameIdAfterStep))).toBe(true);
    expect(compacted.frames).toHaveLength(3);
    expect(
      validateHarnessAgentSnapshotFrameRegistry({
        episode: compacted.episode,
        frames: compacted.frames,
        finalAgents: parentAgentStates
      })
    ).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3, mismatches: [] });
    const compactedEnvelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: parent.id,
      createdAt: "2026-07-21T00:30:00.000Z",
      status: compacted.episode.status,
      initialState: compacted.episode.initialState,
      finalState: compacted.episode.finalState,
      socialEpisode: compacted.episode,
      agents: parentAgentStates,
      agentSnapshotFrames: compacted.frames
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(compactedEnvelope)).toEqual([]);
    const rawInlineEnvelope = {
      ...compactedEnvelope,
      socialEpisode: parent,
      agentSnapshotFrames: undefined
    };
    expect(validateHarnessEpisodeArtifactEnvelope(rawInlineEnvelope)).toEqual([]);

    const compactedWithoutRegistry = {
      ...compactedEnvelope,
      agentSnapshotFrames: undefined
    };
    expect(validateHarnessEpisodeArtifactEnvelope(compactedWithoutRegistry).join(" ")).toMatch(
      /actor snapshot frame reference requires an external frame registry/
    );

    const danglingFrameEnvelope = clone(compactedEnvelope);
    danglingFrameEnvelope.socialEpisode.steps[0]!.actorSnapshotFrameIdAfterStep = "agent-snapshot:dangling";
    expect(validateHarnessEpisodeArtifactEnvelope(danglingFrameEnvelope).join(" ")).toMatch(
      /actor snapshot frame agent-snapshot:dangling is missing/i
    );
    const compactedReplay = replaySocialEpisode({
      episode: compacted.episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      agentSnapshotFrames: compacted.frames
    });
    expect(compactedReplay.ok).toBe(true);
    expect(compactedReplay.agentStateAudit).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3 });

    const checkpoint = buildHarnessCheckpointAtPrefix<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, LedgerCheckpointActorState>({
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-prefix-after-a",
      createdAt: "2026-07-21T01:00:00.000Z",
      sourceArtifactVersion: "ledger.episode.v1",
      runId: parent.id,
      sourceStatus: parent.status,
      episode: compacted.episode,
      selector: { nativeStepCount: 1 },
      resolveAgentSnapshot: createHarnessAgentSnapshotFrameResolver(compacted.frames),
      replayPrefix: (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          validateExpectedFinalState: false,
          agentSnapshotFrames: compacted.frames
        }),
      recordedAgentState: {
        mode: "validate",
        validator({ agents, step }) {
          return agents.some((agent) => !agent.id) || !step.traceId ? ["ledger actor state is malformed"] : [];
        }
      }
    });

    expect(checkpoint.executionPrefix.steps).toHaveLength(1);
    expect(checkpoint.executionPrefix.messages).toEqual([]);
    expect(checkpoint.state).toMatchObject({ turn: 1, done: false, entries: ["a:parent-a"] });
    expect(checkpoint.agents).toEqual([
      { id: "a", committedEntries: ["a:parent-a"] },
      { id: "b", committedEntries: [] },
      { id: "c", committedEntries: [] }
    ]);
    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(
      validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          auditAgentSnapshots: false
        })
      )
    ).toEqual([]);

    const verifyLedgerCheckpointReplay = (candidate: typeof checkpoint) =>
      validateHarnessCheckpointReplay(candidate, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          auditAgentSnapshots: false
        })
      );

    let semanticOptOutEnvironmentRestores = 0;
    let semanticOptOutActorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint,
        runtime: {
          recordedAgentState: { mode: "none", reason: "state-bearing checkpoint must reject this opt-out" },
          createEnvironment(initialState) {
            semanticOptOutEnvironmentRestores += 1;
            return new LedgerEnvironment({ initialState });
          },
          restoreActors() {
            semanticOptOutActorRestores += 1;
            return [];
          }
        },
        verifyCheckpointReplay: verifyLedgerCheckpointReplay,
        episode: {
          id: "ledger-semantic-opt-out-forbidden",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/mode=none is not allowed because the checkpoint records durable actor state/i);
    expect(semanticOptOutEnvironmentRestores).toBe(0);
    expect(semanticOptOutActorRestores).toBe(0);

    const forked = await runForkedHarnessEpisode({
      checkpoint,
      createdAt: "2026-07-21T01:00:01.000Z",
      reason: "ledger continuation proof",
      runtime: {
        recordedAgentState: {
          mode: "validate",
          validator: (candidate) => candidate.agents.some((agent) => !agent.id) ? ["ledger actor id is missing"] : []
        },
        createEnvironment(initialState) {
          return new LedgerEnvironment({ initialState });
        },
        restoreActors(agentStates) {
          return agentStates.map((state) => new CheckpointLedgerActor(state.id, `fork-${state.id}`, state));
        },
        captureAgentSnapshots(actors) {
          return actors.map((actor) => {
            if (!(actor instanceof CheckpointLedgerActor)) throw new Error("ledger fork restored an unexpected actor type");
            return actor.snapshot();
          });
        }
      },
      verifyCheckpointReplay: verifyLedgerCheckpointReplay,
      episode: {
        id: "ledger-generic-prefix-fork",
        schedulerMode: "aec",
        hashState: hashStableState,
        hashMessages: hashStableState
      }
    });

    expect(forked.seed.initialState).toEqual(checkpoint.state);
    expect(forked.seed.initialAgentStates).toEqual(checkpoint.agents);
    expect(forked.seed.forkOf).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      parentRunId: parent.id,
      parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
      parentStateHash: checkpoint.source.stateHash,
      parentNativeStepCount: 1,
      parentMessageCount: 0
    });
    expect(forked.socialEpisode.initialState).toEqual(checkpoint.state);
    expect(forked.socialEpisode.steps[0]).toMatchObject({ actorId: "b", preStateHash: checkpoint.source.stateHash });
    expect(forked.socialEpisode.finalState).toMatchObject({
      done: true,
      entries: ["a:parent-a", "b:fork-b", "c:fork-c"]
    });
    expect(forked.socialEpisode.steps).toHaveLength(2);
    expect(forked.socialEpisode.steps.every((step) => Array.isArray(step.actorSnapshotsAfterStep))).toBe(true);

    // A child continuation records its own receipt-after durable snapshots,
    // so it can become a checkpoint authority and seed a second fork without
    // reconstructing actor state from a transcript or calling a model.
    const forkedCompacted = compactRecordedSocialAgentSnapshots<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >({ episode: forked.socialEpisode });
    const childCheckpoint = buildHarnessCheckpointAtPrefix<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >({
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-prefix-after-fork-b",
      createdAt: "2026-07-21T01:00:02.000Z",
      sourceArtifactVersion: "ledger.episode.v1",
      runId: forked.socialEpisode.id,
      sourceStatus: forked.socialEpisode.status,
      episode: forkedCompacted.episode,
      selector: { nativeStepCount: 1 },
      recordedAgentState: {
        mode: "validate",
        validator: ({ agents }) =>
          agents.some((agent) => !agent.id) ? ["ledger child actor state is malformed"] : []
      },
      resolveAgentSnapshot: createHarnessAgentSnapshotFrameResolver(forkedCompacted.frames),
      replayPrefix: (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment({ initialState: executionPrefix.initialState }),
          hashState: hashStableState,
          hashMessages: hashStableState,
          validateExpectedFinalState: false,
          agentSnapshotFrames: forkedCompacted.frames
        })
    });
    expect(validateHarnessCheckpointEnvelope(childCheckpoint)).toEqual([]);
    expect(childCheckpoint.agents).toEqual([
      { id: "a", committedEntries: ["a:parent-a"] },
      { id: "b", committedEntries: ["b:fork-b"] },
      { id: "c", committedEntries: [] }
    ]);

    const recursivelyForked = await runForkedHarnessEpisode({
      checkpoint: childCheckpoint,
      createdAt: "2026-07-21T01:00:03.000Z",
      reason: "ledger recursive continuation proof",
      runtime: {
        recordedAgentState: {
          mode: "validate",
          validator: (candidate) => candidate.agents.some((agent) => !agent.id) ? ["ledger actor id is missing"] : []
        },
        createEnvironment(initialState) {
          return new LedgerEnvironment({ initialState });
        },
        restoreActors(agentStates) {
          return agentStates.map((state) => new CheckpointLedgerActor(state.id, `recursive-${state.id}`, state));
        },
        captureAgentSnapshots(actors) {
          return actors.map((actor) => {
            if (!(actor instanceof CheckpointLedgerActor)) throw new Error("recursive fork restored an unexpected actor type");
            return actor.snapshot();
          });
        }
      },
      verifyCheckpointReplay: (candidate) =>
        validateHarnessCheckpointReplay(candidate, (executionPrefix) =>
          replaySocialEpisode({
            episode: executionPrefix,
            environment: new LedgerEnvironment({ initialState: executionPrefix.initialState }),
            hashState: hashStableState,
            hashMessages: hashStableState,
            auditAgentSnapshots: false
          })
        ),
      episode: {
        id: "ledger-generic-prefix-recursive-fork",
        schedulerMode: "aec",
        hashState: hashStableState,
        hashMessages: hashStableState
      }
    });
    expect(recursivelyForked.seed.forkOf.parentRunId).toBe(forked.socialEpisode.id);
    expect(recursivelyForked.socialEpisode.steps).toHaveLength(1);
    expect(recursivelyForked.socialEpisode.steps[0]).toMatchObject({
      actorId: "c",
      actorSnapshotsAfterStep: [
        { id: "a", committedEntries: ["a:parent-a"] },
        { id: "b", committedEntries: ["b:fork-b"] },
        { id: "c", committedEntries: ["c:recursive-c"] }
      ]
    });
    expect(recursivelyForked.socialEpisode.finalState).toMatchObject({
      done: true,
      entries: ["a:parent-a", "b:fork-b", "c:recursive-c"]
    });

    const structurallySelfConsistentButUnreplayable = clone(checkpoint);
    structurallySelfConsistentButUnreplayable.executionPrefix.steps[0]!.action.command.entry = "tampered-command";
    structurallySelfConsistentButUnreplayable.source.executionPrefixHash = hashStableState(
      structurallySelfConsistentButUnreplayable.executionPrefix
    );
    expect(validateHarnessCheckpointEnvelope(structurallySelfConsistentButUnreplayable)).toEqual([]);
    let environmentRestores = 0;
    let actorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: structurallySelfConsistentButUnreplayable,
        runtime: {
          recordedAgentState: {
            mode: "validate",
            validator: (candidate) => candidate.agents.some((agent) => !agent.id) ? ["ledger actor id is missing"] : []
          },
          createEnvironment(initialState) {
            environmentRestores += 1;
            return new LedgerEnvironment({ initialState });
          },
          restoreActors(agentStates) {
            actorRestores += 1;
            return agentStates.map((state) => new CheckpointLedgerActor(state.id, `forbidden-${state.id}`, state));
          }
        },
        verifyCheckpointReplay: verifyLedgerCheckpointReplay,
        episode: {
          id: "ledger-generic-prefix-invalid-fork",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/Checkpoint replay verification failed/);
    expect(environmentRestores).toBe(0);
    expect(actorRestores).toBe(0);

    const withoutSnapshot = clone(compacted.episode);
    delete withoutSnapshot.steps[0]?.actorSnapshotsHashAfterStep;
    delete withoutSnapshot.steps[0]?.actorSnapshotFrameIdAfterStep;
    expect(() =>
      buildHarnessCheckpointAtPrefix({
        artifactVersion: "ledger.checkpoint.v1",
        kind: "ledger-checkpoint",
        sourceArtifactVersion: "ledger.episode.v1",
        episode: withoutSnapshot,
        selector: { nativeStepCount: 1 },
        recordedAgentState: { mode: "validate", validator: () => [] },
        resolveAgentSnapshot: createHarnessAgentSnapshotFrameResolver(compacted.frames),
        replayPrefix: () => {
          throw new Error("replay must not run when durable snapshots are absent");
        }
      })
    ).toThrow(expect.objectContaining({ code: "missing_agent_snapshots" } satisfies Partial<HarnessCheckpointSelectionError>));

    const tamperedSnapshot = clone(parent);
    (tamperedSnapshot.steps[0]?.actorSnapshotsAfterStep as LedgerCheckpointActorState[])[0]!.committedEntries.push("tampered");
    const tamperedReplay = replaySocialEpisode({
      episode: tamperedSnapshot,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(tamperedReplay.ok).toBe(false);
    expect(tamperedReplay.mismatches.join(" ")).toMatch(/Recorded agent state audit: .*snapshot hash mismatch/);

    const tamperedFrameRegistry = clone(compacted.frames);
    tamperedFrameRegistry[0]!.agents[0]!.committedEntries.push("tampered-frame");
    const tamperedFrameReplay = replaySocialEpisode({
      episode: compacted.episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      agentSnapshotFrames: tamperedFrameRegistry
    });
    expect(tamperedFrameReplay.ok).toBe(false);
    expect(tamperedFrameReplay.mismatches.join(" ")).toMatch(/resolved actor snapshot hash mismatch|frame reference cannot be resolved/);

    const danglingFrameEpisode = clone(compacted.episode);
    danglingFrameEpisode.steps[0]!.actorSnapshotFrameIdAfterStep = "agent-snapshot:dangling";
    const danglingFrameAudit = validateHarnessAgentSnapshotFrameRegistry({
      episode: danglingFrameEpisode,
      frames: compacted.frames,
      finalAgents: parentAgentStates
    });
    expect(danglingFrameAudit.ok).toBe(false);
    expect(danglingFrameAudit.mismatches.join(" ")).toMatch(/actor snapshot frame agent-snapshot:dangling is missing/i);
  });

  it("rejects a repeated policy trace before a second generic transition and preserves the first snapshot binding", async () => {
    const environment = new LedgerEnvironment({ actorIds: ["a", "a"] });
    const actor = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      traceId: "ledger-duplicate-policy-trace",
      command: { actorId: "a", entry: "duplicate-trace-attempt" }
    }));
    let snapshotCaptures = 0;
    const episode = await runHarnessEpisode<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      { id: LedgerActorId; durableMemoryVersion: number }
    >({
      id: "ledger-duplicate-trace",
      environment,
      actors: [actor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => {
        snapshotCaptures += 1;
        return [{ id: "a", durableMemoryVersion: environment.snapshot().turn }];
      }
    });

    expect(episode.status).toBe("failed");
    expect(episode.failureReason).toMatch(/already recorded by an earlier native step/);
    expect(environment.stepCalls).toBe(1);
    expect(snapshotCaptures).toBe(1);
    expect(episode.steps).toHaveLength(2);
    expect(episode.steps[0]).toMatchObject({
      traceId: "ledger-duplicate-policy-trace",
      actorId: "a",
      commitStatus: "committed",
      actorSnapshotsAfterStep: [{ id: "a", durableMemoryVersion: 1 }]
    });
    expect(episode.steps[1]).toMatchObject({
      actorId: "system",
      commitStatus: "rejected",
      failure: { stage: "trace_identity" }
    });
    expect(episode.steps[1]?.actorSnapshotsAfterStep).toBeUndefined();
    expect(new Set(episode.steps.map((step) => step.traceId)).size).toBe(episode.steps.length);
    expect(actor.receipts.map((receipt) => receipt.status)).toEqual(["committed", "rejected"]);
    expect(actor.receipts[1]?.traceId).toBe(episode.steps[1]?.traceId);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    const agents = [{ id: "a" as LedgerActorId, durableMemoryVersion: 1 }];
    const envelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: episode.id,
      createdAt: "2026-07-21T02:00:00.000Z",
      status: episode.status,
      initialState: episode.initialState,
      finalState: episode.finalState,
      socialEpisode: episode,
      agents
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      (typeof agents)[number]
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(envelope)).toEqual([]);
  });

  it("records an environment-rejected proposal without mutating state or committing its message", async () => {
    const environment = new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" });
    const actor = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "forbidden" },
      messages: [message("public-ledger", "a", ["a", "b", "c"], "public", "This message must not commit")]
    }));

    const episode = await runSocialEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-rejected-proposal",
      environment,
      actors: [actor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const initialState: LedgerState = {
      turn: 0,
      done: false,
      entries: [],
      secrets: { a: "token-a", b: "token-b", c: "token-c" }
    };
    expect(episode.status).toBe("failed");
    expect(episode.failureReason).toContain("ledger rejected entry forbidden");
    expect(episode.messages).toEqual([]);
    expect(episode.finalState).toEqual(initialState);
    expect(episode.steps).toHaveLength(1);
    expect(episode.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "rejected",
      preStateHash: hashStableState(initialState),
      postStateHash: hashStableState(initialState),
      failure: { stage: "environment_validation", message: "ledger rejected entry forbidden" }
    });
    expect(episode.steps[0]?.messageSeqRange).toBeUndefined();
    expect(actor.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);

    const replayEnvironment = new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" });
    const replay = replaySocialEpisode({
      episode,
      environment: replayEnvironment,
      hashState: hashStableState,
      hashMessages: hashStableState
    });

    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(1);
    expect(replayEnvironment.stepCalls).toBe(0);
    expect(replay.finalState).toEqual(initialState);
  });

  it("commits scaffolded agent state only after a committed environment receipt", async () => {
    const createActor = (entry: string, actionTraceId?: string) =>
      new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
        id: "a",
        profile: { id: "ledger-scaffold-a", model: "deterministic-a", policyId: "ledger-policy" },
        policy: {
          id: "ledger-policy",
          decide(input) {
            return {
              actorId: input.agent.id as LedgerActorId,
              kind: "record",
              traceId: actionTraceId,
              command: { actorId: input.agent.id as LedgerActorId, entry }
            };
          }
        },
        reasoner: {
          id: "ledger-memo",
          reflect() {
            return `memo:${entry}`;
          }
        }
      });
    const assembleObservation = (context: {
      environmentObservation: LedgerObservation;
      visibleSocial: { messages: SocialMessage[]; channels: SocialChannel[] };
    }): LedgerObservation => ({
      ...context.environmentObservation,
      visibleMessages: context.visibleSocial.messages,
      channels: context.visibleSocial.channels
    });

    const rejectedActor = createActor("forbidden");
    const rejected = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scaffold-rejected",
      environment: new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" }),
      actors: [rejectedActor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation
    });

    expect(rejected.steps[0]).toMatchObject({ commitStatus: "rejected", failure: { stage: "environment_validation" } });
    expect(rejectedActor.state).toMatchObject({ observations: 0, decisions: 0, memory: [] });
    expect(rejectedActor.state.lastObservation).toBeUndefined();
    expect(rejectedActor.state.lastAction).toBeUndefined();
    expect(rejectedActor.state.social.memory.entries).toEqual([]);
    expect(rejectedActor.state.social.journal?.entries ?? []).toEqual([]);

    const committedActor = createActor("opening", "ledger-policy-owned-trace");
    const committed = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scaffold-committed",
      environment: new LedgerEnvironment({ actorIds: ["a"] }),
      actors: [committedActor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation
    });

    expect(committed.steps[0]).toMatchObject({
      traceId: "ledger-policy-owned-trace",
      commitStatus: "committed"
    });
    expect(committedActor.state).toMatchObject({ observations: 1, decisions: 1 });
    expect(committedActor.state.memory.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision", "outcome"]);
    expect(committedActor.state.social.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "memory.appended",
      "memory.appended",
      "memory.appended",
      "memory.appended"
    ]);
  });

  it("evaluates a non-Werewolf social snapshot without a game view or command contract", () => {
    const social = createAgentSocialState<LedgerObservation, LedgerPending, LedgerCommand>({
      agentId: "a",
      profile: { id: "ledger-a", model: "deterministic-a", policyId: "ledger-policy" }
    });
    appendSocialMemory(social, {
      kind: "observation",
      source: "ledger-environment",
      visibility: "private",
      content: "a observed its private ledger token",
      evidenceRefs: [{ artifact: "observation", id: "ledger-observation-1" }],
      tags: ["ledger", "private"]
    });

    const report = runEvaluationRegistry({
      id: "ledger-social-evaluation",
      context: {
        id: "ledger-social-evaluation",
        status: "completed" as const,
        initialState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        finalState: { turn: 1, done: false, entries: ["a:opening"], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        agents: [{ id: "a", social, socialStateHash: "ledger-social-hash" }],
        trajectory: [{ turn: 1, action: "record" }],
        socialEpisode: { domainId: "ledger" }
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.outputs["social.state.v1"]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      memoryEntries: 1
    });
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent.social.memory_count",
          subjectId: "a",
          subject: expect.objectContaining({ actorId: "a", policyId: "ledger-policy" }),
          value: 1
        })
      ])
    );
  });

  it("accepts the generic scaffold state as a social evaluation snapshot without an adapter", () => {
    const actor = new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
      id: "b",
      profile: { id: "ledger-b", model: "deterministic-b", policyId: "ledger-policy" },
      policy: {
        id: "ledger-policy",
        decide(input) {
          return {
            actorId: input.agent.id as LedgerActorId,
            kind: "record",
            command: { actorId: input.agent.id as LedgerActorId, entry: "scaffolded" }
          };
        }
      }
    });

    const report = runEvaluationRegistry({
      id: "ledger-scaffold-evaluation",
      context: {
        id: "ledger-scaffold-evaluation",
        status: "completed" as const,
        initialState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        finalState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        agents: [actor.state],
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.outputs["social.state.v1"]).toMatchObject({ agentCount: 1, agentsWithSocialState: 1 });
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent.social.memory_count", subjectId: "b", subject: expect.objectContaining({ actorId: "b" }) })
      ])
    );
  });
});

class LedgerActor implements SocialActor<LedgerObservation, LedgerPending, LedgerCommand> {
  readonly profile: SocialAgentProfile;
  readonly observations: LedgerObservation[] = [];
  readonly receipts: Array<SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>> = [];

  constructor(
    readonly id: LedgerActorId,
    private readonly actionForPending: (pending: LedgerPending) => SocialAction<LedgerCommand>
  ) {
    this.profile = {
      id,
      version: "1",
      model: `deterministic-${id}`,
      policyId: "ledger.policy.local"
    };
  }

  observe(observation: LedgerObservation): void {
    this.observations.push(clone(observation));
  }

  decide(pending: LedgerPending): SocialAction<LedgerCommand> {
    return this.actionForPending(pending);
  }

  onStepResult(receipt: SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>): void {
    this.receipts.push(clone(receipt));
  }
}

interface LedgerCheckpointActorState {
  id: LedgerActorId;
  committedEntries: string[];
}

/** A tiny durable actor used only to prove generic checkpoint restoration. */
class CheckpointLedgerActor implements SocialActor<LedgerObservation, LedgerPending, LedgerCommand> {
  readonly profile: SocialAgentProfile;
  private state: LedgerCheckpointActorState;

  constructor(
    readonly id: LedgerActorId,
    private readonly entry: string,
    restored?: LedgerCheckpointActorState
  ) {
    this.profile = { id: `checkpoint-${id}`, model: `deterministic-${id}`, policyId: "ledger-checkpoint" };
    this.state = restored ? clone(restored) : { id, committedEntries: [] };
  }

  observe(): void {
    // The Ledger environment owns observations; this fixture's durable state
    // changes exclusively at the post-environment receipt boundary.
  }

  decide(pending: LedgerPending): SocialAction<LedgerCommand> {
    return {
      actorId: this.id,
      kind: pending.kind,
      command: { actorId: this.id, entry: this.entry }
    };
  }

  onStepResult(receipt: SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>): void {
    if (receipt.status === "committed") this.state.committedEntries.push(`${this.id}:${this.entry}`);
  }

  snapshot(): LedgerCheckpointActorState {
    return clone(this.state);
  }
}

/** True joint-action fixture for the generic parallel replay boundary. */
class ParallelLedgerEnvironment implements SocialParallelEnvironment<LedgerState, LedgerObservation, LedgerPending, LedgerCommand> {
  private state: LedgerState = {
    turn: 0,
    done: false,
    entries: [],
    secrets: { a: "token-a", b: "token-b", c: "token-c" }
  };

  snapshot(): LedgerState {
    return clone(this.state);
  }

  pendingActions(): LedgerPending[] {
    return this.state.done
      ? []
      : [
          { actorId: "a", kind: "record" },
          { actorId: "b", kind: "record" }
        ];
  }

  observe(agentId: string, pending: LedgerPending): LedgerObservation {
    if (agentId !== pending.actorId) throw new Error(`pending actor mismatch ${agentId}`);
    return {
      agentId: pending.actorId,
      pendingKind: pending.kind,
      turn: this.state.turn,
      privateToken: this.state.secrets[pending.actorId]
    };
  }

  step(): LedgerState {
    throw new Error("Parallel Ledger environment requires one atomic stepBatch().");
  }

  stepBatch(commandsByAgent: Record<string, LedgerCommand>): LedgerState {
    const actorIds = Object.keys(commandsByAgent).sort();
    if (JSON.stringify(actorIds) !== JSON.stringify(["a", "b"])) throw new Error("parallel ledger batch requires a and b commands.");
    this.state.entries.push(`a:${commandsByAgent.a!.entry}`, `b:${commandsByAgent.b!.entry}`);
    this.state.turn = 1;
    this.state.done = true;
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

class LedgerEnvironment implements SocialEnvironment<LedgerState, LedgerObservation, LedgerPending, LedgerCommand> {
  private readonly state: LedgerState;
  stepCalls = 0;
  private readonly actorIds: LedgerActorId[];
  private readonly rejectedEntry?: string;

  constructor(options: { actorIds?: LedgerActorId[]; rejectedEntry?: string; initialState?: LedgerState } = {}) {
    this.actorIds = options.actorIds ?? ["a", "b", "c"];
    this.rejectedEntry = options.rejectedEntry;
    this.state = clone(
      options.initialState ?? {
        turn: 0,
        done: false,
        entries: [],
        secrets: { a: "token-a", b: "token-b", c: "token-c" }
      }
    );
  }

  snapshot(): LedgerState {
    return clone(this.state);
  }

  pendingActions(): LedgerPending[] {
    const actorId = this.actorIds[this.state.turn];
    return this.state.done || !actorId ? [] : [{ actorId, kind: "record" }];
  }

  observe(agentId: string, pending: LedgerPending): LedgerObservation {
    if (agentId !== pending.actorId) throw new Error(`pending actor mismatch ${agentId}`);
    return {
      agentId: pending.actorId,
      pendingKind: pending.kind,
      turn: this.state.turn,
      privateToken: this.state.secrets[pending.actorId]
    };
  }

  step(command: LedgerCommand): LedgerState {
    const pending = this.pendingActions()[0];
    if (!pending || command.actorId !== pending.actorId) throw new Error(`ledger rejects actor ${command.actorId}`);
    if (command.entry === this.rejectedEntry) throw new Error(`ledger rejected entry ${command.entry}`);
    this.stepCalls += 1;
    this.state.entries.push(`${command.actorId}:${command.entry}`);
    this.state.turn += 1;
    this.state.done = this.state.turn >= this.actorIds.length;
    return this.snapshot();
  }

  validateAction(command: LedgerCommand, pending: LedgerPending) {
    if (command.actorId !== pending.actorId) {
      return { valid: false, code: "actor-mismatch", message: `ledger rejects actor ${command.actorId}` };
    }
    if (command.entry === this.rejectedEntry) {
      return { valid: false, code: "forbidden-entry", message: `ledger rejected entry ${command.entry}` };
    }
    return { valid: true };
  }

  done(): boolean {
    return this.state.done;
  }
}

function message(
  channelId: string,
  senderId: LedgerActorId,
  recipientIds: LedgerActorId[],
  visibility: "public" | "private",
  content: string,
  speechActs?: SocialMessage["speechActs"]
): LedgerMessageDraft {
  return { channelId, senderId, recipientIds, visibility, content, speechActs };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
