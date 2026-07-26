import type { GameCommand, GameState } from "../../core/types";
import {
  WerewolfAgentActor,
  WEREWOLF_AGENT_JOURNAL_MAX_ENTRIES,
  WEREWOLF_AGENT_MEMORY_MAX_ENTRIES,
  validateWerewolfAgentHarnessStateSnapshot
} from "../actor";
import { hashStableState } from "../hash";
import { policyForRole } from "../policy";
import { SocialCommunicationBus } from "../social";
import { runHarnessEpisode } from "../runner";
import { createAgentSocialState } from "../socialState";
import { describeError } from "../providerFailure";
import {
  classifyHarnessReasonerExecution,
  type AgentHarnessState,
  type HarnessAgentConfig,
  type HarnessRunOptions,
  type HarnessRunResult,
  type HarnessTurnTrace,
  type WerewolfLivePublicState
} from "../types";
import { buildWerewolfHarnessRunResultFromParts } from "../werewolfResult";
import type {
  AgentSnapshotAfterStep,
  WerewolfHarnessTurnProbeOptions,
  WerewolfSocialHarnessPrefixOptions,
  WerewolfSocialHarnessPrefixResult
} from "./adapterTypes";
import { WerewolfSocialActorAdapter } from "./actorAdapter";
import { cloneJson, snapshotAgentStates } from "./internals";
import {
  createWerewolfSocialDomainAdapterManifest,
  projectWerewolfLivePublicState
} from "./publicProjection";
import {
  WerewolfSocialEnvironment,
  assembleWerewolfSocialObservation,
  createWerewolfSocialChannels,
  werewolfSystemTransition
} from "./socialEnvironment";
import {
  attachAgentSnapshotsToSocialSteps,
  projectWerewolfSuccessfulSocialSteps,
  toWerewolfLegacySocialSteps
} from "./stepProjection";
import {
  createSequentialActorTurnIndexProvider,
  createWerewolfJointPhaseSchedulerResolver,
  recordWerewolfDecisionFailure,
  recordWerewolfEnvironmentStepFailure,
  werewolfEventSeq,
  werewolfLegacyTraceId
} from "./runnerHooks";

export function initializeWerewolfAgentActors(
  state: GameState,
  configs: HarnessAgentConfig[],
  restoredStates: AgentHarnessState[] = []
): Map<string, WerewolfAgentActor> {
  const configByPlayer = new Map(configs.map((config) => [config.playerId, config]));
  const restoredByPlayer = new Map(restoredStates.map((agent) => [agent.playerId, cloneJson(agent)]));
  return new Map(
    state.players.map((player): [string, WerewolfAgentActor] => {
      const config = configByPlayer.get(player.id);
      if (!config) throw new Error(`No harness agent config for ${player.id}.`);
      const policyName = config.policyName ?? policyForRole(player.role);
      const restored = restoredByPlayer.get(player.id);
      if (restored) {
        const restoredErrors = validateWerewolfAgentHarnessStateSnapshot(restored, {
          requireSocialState: true,
          requireSocialStateHash: true
        });
        if (restoredErrors.length) {
          throw new Error(`Invalid restored Werewolf agent state ${player.id}: ${restoredErrors.join(" ")}`);
        }
        const restoredPolicyName = config.policyName ?? restored.policyName ?? policyName;
        const restoredState: AgentHarnessState = {
          ...restored,
          playerId: player.id,
          profileId: config.profileId ?? restored.profileId,
          model: config.model,
          temperature: config.temperature,
          policyName: restoredPolicyName,
          beliefs: cloneJson(restored.beliefs ?? {}),
          privateMemos: cloneJson(restored.privateMemos ?? []),
          social: cloneJson(restored.social),
          // The child assignment may intentionally change profile/model/policy.
          // Validate the canonical parent snapshot before that rewrite, then
          // let the actor derive the child hash from the rewritten state.
          socialStateHash: undefined
        };
        if (restoredState.social) {
          restoredState.social.profile = {
            ...restoredState.social.profile,
            id: restoredState.profileId ?? player.id,
            model: restoredState.model,
            temperature: restoredState.temperature,
            policyId: restoredState.policyName
          };
        }
        return [player.id, new WerewolfAgentActor(restoredState)];
      }
      return [
        player.id,
        new WerewolfAgentActor({
          playerId: player.id,
          profileId: config.profileId,
          model: config.model,
          temperature: config.temperature,
          policyName,
          turns: 0,
          observations: 0,
          beliefs: {},
          privateMemos: [],
          social: createAgentSocialState({
            agentId: player.id,
            profile: {
              id: config.profileId ?? player.id,
              model: config.model,
              temperature: config.temperature,
              role: player.role,
              team: player.team,
              policyId: policyName
            },
            // Werewolf snapshots are recorded at native boundaries. Bound
            // actor-local history so a long real match does not duplicate an
            // ever-growing journal/transcript prefix into every frame.
            maxMemoryEntries: WEREWOLF_AGENT_MEMORY_MAX_ENTRIES,
            maxJournalEntries: WEREWOLF_AGENT_JOURNAL_MAX_ENTRIES
          })
        } satisfies AgentHarnessState)
      ];
    })
  );
}

export async function runWerewolfSocialHarnessPrefix(options: WerewolfSocialHarnessPrefixOptions): Promise<WerewolfSocialHarnessPrefixResult> {
  const initialState = cloneJson(options.initialState);
  const agentActors = initializeWerewolfAgentActors(initialState, options.agents, options.initialAgentStates);
  const agentSnapshotsByTraceId = new Map<string, AgentSnapshotAfterStep>();
  let lastLivePublicStateHash: string | undefined;
  const recordAgentSnapshots = options.recordAgentSnapshots ?? true;
  const actors = [...agentActors.values()].map(
    (actor) =>
      new WerewolfSocialActorAdapter({
        actor,
        reasoner: options.reasoner,
        players: initialState.players,
        executionMode: "scaffold"
      })
  );
  const channels = cloneJson(options.initialSocialChannels ?? createWerewolfSocialChannels(initialState.players));
  const artifact = await runHarnessEpisode({
    id: options.id ?? initialState.id,
    domainId: "werewolf",
    domainAdapter: createWerewolfSocialDomainAdapterManifest(initialState.config.rulesetId),
    environment: WerewolfSocialEnvironment.fromState(initialState),
    actors,
    reasoner: options.reasoner,
    channels,
    initialMessages: cloneJson(options.initialSocialMessages ?? []),
    schedulerMode: options.schedulerMode ?? "aec",
    maxTransitions: options.maxTransitions,
    executionLimits: options.executionLimits,
    hashState: hashStableState,
    hashMessages: hashStableState,
    eventSeq: werewolfEventSeq,
    afterEnvironmentStep: (context) => {
      // Every committed native boundary, including deterministic system
      // transitions, must carry the durable actor-state snapshot needed by
      // checkpoint/replay authority. Agent state is unchanged by a system
      // transition, but omitting the snapshot made a run truncated exactly at
      // that boundary impossible to checkpoint.
      if (recordAgentSnapshots) {
        const traceId = context.action.traceId;
        if (traceId) {
          const agents = snapshotAgentStates(actors);
          agentSnapshotsByTraceId.set(traceId, {
            agents,
            hash: hashStableState(agents)
          });
        }
      }
      if (!options.onLivePublicState) return;
      // Parallel stepBatch calls this hook once per actor after every receipt
      // has been delivered. Deduplicate by the safe public projection so a
      // private batch cannot manufacture visible scheduler cadence.
      try {
        const publicState = projectWerewolfLivePublicState(context.feedback.state);
        const publicStateHash = hashStableState(publicState);
        if (publicStateHash === lastLivePublicStateHash) return;
        lastLivePublicStateHash = publicStateHash;
        const observerResult = (options.onLivePublicState as (state: WerewolfLivePublicState) => unknown)(cloneJson(publicState));
        // The public observer is intentionally typed as synchronous. Still,
        // isolate accidental JavaScript thenables so their rejection cannot
        // become an unhandled process-level failure after a committed step.
        if (isThenable(observerResult)) {
          void Promise.resolve(observerResult).catch(() => undefined);
        }
      } catch {
        // A live UI/cache observer is outside environment authority. It must
        // never turn an already committed receipt into a harness failure.
      }
    },
    assembleObservation: assembleWerewolfSocialObservation,
    systemTransition: werewolfSystemTransition,
    traceIdForDecision: options.traceIdForDecision ?? werewolfLegacyTraceId,
    actorTurnIndexForDecision: options.actorTurnIndexForDecision ?? createSequentialActorTurnIndexProvider(),
    schedulerModeForBatch:
      options.schedulerModeForBatch ?? createWerewolfJointPhaseSchedulerResolver(options.jointPhaseScheduler),
    onDecisionFailure: options.onDecisionFailure ?? recordWerewolfDecisionFailure,
    onEnvironmentStepFailure: options.onEnvironmentStepFailure ?? recordWerewolfEnvironmentStepFailure
  });
  attachAgentSnapshotsToSocialSteps(artifact.steps, agentSnapshotsByTraceId);
  const projectedSteps = projectWerewolfSuccessfulSocialSteps(artifact.steps, agentSnapshotsByTraceId);

  return {
    artifact,
    trajectory: projectedSteps.map((step) => step.harnessStep),
    socialSteps: toWerewolfLegacySocialSteps(initialState.id, projectedSteps),
    actors,
    agentStates: actors.map((actor) => cloneJson(actor.state)),
    channels: artifact.channels.map(cloneJson)
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export async function runWerewolfSocialHarnessPrefixAsHarnessResult(
  options: WerewolfSocialHarnessPrefixOptions & { forkOf?: HarnessRunOptions["forkOf"] }
): Promise<HarnessRunResult> {
  const initializationFailure = tryBuildWerewolfInitializationFailureResult(options);
  if (initializationFailure) return initializationFailure;
  const prefix = await runWerewolfSocialHarnessPrefix(options);
  return buildWerewolfHarnessRunResultFromParts({
    status: prefix.artifact.status,
    truncationReason: prefix.artifact.truncationReason,
    failureReason: prefix.artifact.failureReason,
    initialState: prefix.artifact.initialState,
    finalState: prefix.artifact.finalState,
    agentStates: prefix.agentStates,
    trajectory: prefix.trajectory,
    socialEpisode: prefix.artifact,
    forkOf: options.forkOf
  });
}

/**
 * Executes production actor cognition and a pure environment preflight, but
 * deliberately neither steps the environment nor emits an artifact. A probe
 * is therefore useful live-provider evidence without becoming an unrecorded
 * match transition or a side channel for private command details.
 */
export async function probeWerewolfSocialHarnessTurn(options: WerewolfHarnessTurnProbeOptions): Promise<{
  trace: HarnessTurnTrace;
  command: GameCommand;
  environmentValidated: true;
}> {
  const probeConfigs = options.state.players.map((player) => ({
    playerId: player.id,
    profileId: player.id === options.agent.playerId ? options.agent.profileId : undefined,
    model: options.agent.model,
    temperature: options.agent.temperature,
    policyName: player.id === options.agent.playerId ? options.agent.policyName : undefined
  }));
  const agentActors = initializeWerewolfAgentActors(options.state, probeConfigs);
  const actor = agentActors.get(options.action.actorId);
  if (!actor) throw new Error(`Missing harness agent ${options.action.actorId}.`);

  const environment = WerewolfSocialEnvironment.fromState(options.state);
  const socialBus = new SocialCommunicationBus(createWerewolfSocialChannels(options.state.players));
  const state = environment.snapshot();
  const traceId = `${state.id}:harness:1:${options.action.actorId}:${state.phase}`;
  const environmentObservation = environment.observe(options.action.actorId, options.action);
  const observation = assembleWerewolfSocialObservation({
    agentId: options.action.actorId,
    pendingAction: cloneJson(options.action),
    environmentObservation,
    visibleSocial: socialBus.observe(options.action.actorId)
  });
  const socialActor = new WerewolfSocialActorAdapter({
    actor,
    reasoner: options.reasoner,
    players: options.state.players,
    executionMode: "scaffold"
  });
  socialActor.observe(observation, {
    traceId,
    turnIndex: 1,
    actorTurnIndex: 1,
    batchId: `${state.id}:probe:1`,
    batchIndex: 1,
    batchSize: 1,
    schedulerMode: "aec",
    pendingAction: cloneJson(options.action)
  });
  const action = await socialActor.decide(options.action);
  const trace = socialActor.turnTraceFor(action.traceId);
  if (!trace) throw new Error(`Probe did not record a harness turn trace for ${action.traceId ?? options.action.actorId}.`);
  const beforeValidationHash = hashStableState(environment.snapshot());
  const validation = environment.validateAction(action.command, cloneJson(options.action));
  const afterValidationHash = hashStableState(environment.snapshot());
  if (beforeValidationHash !== afterValidationHash) {
    throw new Error("Harness probe environment validation mutated canonical state.");
  }
  if (!validation.valid) {
    throw new Error(`Harness probe command failed environment validation (${validation.code ?? "invalid"}).`);
  }
  return {
    trace,
    command: action.command,
    environmentValidated: true
  };
}

function tryBuildWerewolfInitializationFailureResult(
  options: WerewolfSocialHarnessPrefixOptions & { forkOf?: HarnessRunOptions["forkOf"] }
): HarnessRunResult | undefined {
  const initialState = cloneJson(options.initialState);
  try {
    initializeWerewolfAgentActors(initialState, options.agents, options.initialAgentStates);
    return undefined;
  } catch (error) {
    const channels = cloneJson(options.initialSocialChannels ?? createWerewolfSocialChannels(initialState.players));
    const socialBus = new SocialCommunicationBus(channels, cloneJson(options.initialSocialMessages ?? []));
    const failureReason = describeError(error);
    return buildWerewolfHarnessRunResultFromParts({
      status: "failed",
      failureReason,
      initialState,
      finalState: initialState,
      agentStates: [],
      trajectory: [],
      socialEpisode: {
        id: `${initialState.id}:social-execution:init-failure`,
        status: "failed",
        execution: {
          schemaVersion: "harness.social-execution.v1",
          started: false,
          notStartedStage: "agent-initialization",
          initialMessageCount: socialBus.listMessages().length,
          initialMessagesHash: hashStableState(socialBus.listMessages()),
          reasonerExecutionClass: classifyHarnessReasonerExecution(options.reasoner)
        },
        schedulerMode: "aec",
        profiles: [],
        channels: socialBus.listChannels(),
        initialState,
        finalState: initialState,
        steps: [],
        messages: socialBus.listMessages(),
        failureReason,
        error: failureReason
      },
      forkOf: options.forkOf
    });
  }
}
