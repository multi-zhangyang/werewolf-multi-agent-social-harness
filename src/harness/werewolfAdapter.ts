import { getPendingActions } from "../core/engine";
import { isAgentPendingAction } from "../core/pending";
import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState, PendingAction, Phase, PlayerState, PlayerView } from "../core/types";
import { WerewolfAgentActor } from "./actor";
import { hashStableState } from "./hash";
import { attachSpeech, policyForRole } from "./policy";
import type {
  SocialAction,
  SocialActor,
  SocialActorObservationContext,
  SocialAgentProfile,
  SocialActorTurnIndexProvider,
  SocialBeforeEnvironmentStepContext,
  SocialChannel,
  SocialDecisionFailureHook,
  SocialEnvironment,
  SocialEnvironmentStepFailureHook,
  SocialEpisodeArtifact,
  SocialHarnessStep,
  SocialMessage,
  SocialObservationAssembler,
  SocialSchedulerResolver,
  SocialSystemTransition,
  SocialSystemTransitionProvider,
  SocialTraceIdProvider
} from "./social";
import { SocialCommunicationBus, runSocialEpisode } from "./social";
import { createAgentSocialState } from "./socialState";
import { describeError, providerFailureFromError } from "./providerFailure";
import type {
  AgentHarnessState,
  HarnessAgentConfig,
  HarnessErrorPayload,
  HarnessPlayerView,
  HarnessReasoner,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessStepRecord,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerAgentContext,
  ReasonerOutputSummary
} from "./types";
import { WerewolfEnvironment } from "./environment";
import { buildWerewolfHarnessRunResultFromParts } from "./werewolfResult";

export const WEREWOLF_SYSTEM_ACTOR_ID = "system";

export const WEREWOLF_SYSTEM_PROFILE: SocialAgentProfile = {
  id: WEREWOLF_SYSTEM_ACTOR_ID,
  model: "deterministic-environment",
  policyId: "system-transition",
  metadata: { authority: "environment" }
};

export type WerewolfSocialPendingAction = PendingAction;

export type WerewolfSocialObservation =
  | {
      kind: "player";
      agentId: string;
      view: HarnessPlayerView;
    }
  | {
      kind: "system";
      agentId: typeof WEREWOLF_SYSTEM_ACTOR_ID;
      gameId: string;
      phase: Phase;
      day: number;
      pendingAction: Extract<PendingAction, { kind: "advance" }>;
      social: {
        channels: SocialChannel[];
        messages: SocialMessage[];
      };
    };

export interface WerewolfSocialActorAdapterOptions {
  actor: WerewolfAgentActor;
  reasoner: HarnessReasoner;
  players: PlayerState[];
  tracePrefix?: string;
}

export interface WerewolfMessageDraftInput {
  players: PlayerState[];
  traceId: string;
  turnIndex: number;
  actorId: string;
  pendingAction: AgentPendingAction;
  command: GameCommand;
  policyPlan: PolicyPlan;
  observation: HarnessPlayerView;
  reasonerOutput: ReasonerOutputSummary;
}

export type WerewolfSocialStep = SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand>;
export type WerewolfGenericSocialStep = SocialHarnessStep<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;

export interface WerewolfSocialActionMetadata {
  kind: "werewolf-harness-turn";
  turnIndex?: number;
  policyPlan: PolicyPlan;
  reasonerOutput: ReasonerOutputSummary;
  turnTrace: HarnessTurnTrace;
  agentStateHash?: string;
}

export interface WerewolfSocialStepMetadata {
  schedulerMode: "aec" | "aec-batched-decision";
  resolutionPolicy: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
}

export type WerewolfSocialHarnessPrefixSchedulerMode = "aec" | "aec-batched-decision" | "simultaneous-batch";

export interface WerewolfSocialHarnessPrefixOptions
  extends Pick<
    HarnessRunOptions,
    "initialState" | "agents" | "initialAgentStates" | "initialSocialMessages" | "reasoner" | "maxTransitions" | "recordAgentSnapshots"
  > {
  id?: string;
  schedulerMode?: WerewolfSocialHarnessPrefixSchedulerMode;
  traceIdForDecision?: SocialTraceIdProvider<GameState, WerewolfSocialPendingAction>;
  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<GameState, WerewolfSocialPendingAction>;
  schedulerModeForBatch?: SocialSchedulerResolver<GameState, WerewolfSocialPendingAction>;
  onDecisionFailure?: SocialDecisionFailureHook<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
}

export interface WerewolfSocialHarnessPrefixResult {
  artifact: SocialEpisodeArtifact<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
  trajectory: HarnessStepRecord[];
  socialSteps: WerewolfSocialStep[];
  actors: WerewolfSocialActorAdapter[];
  agentStates: AgentHarnessState[];
  channels: SocialChannel[];
}

interface AgentSnapshotAfterStep {
  agents: AgentHarnessState[];
  hash: string;
}

export interface WerewolfHarnessTurnProbeOptions {
  state: GameState;
  action: AgentPendingAction;
  agent: HarnessAgentConfig;
  reasoner: HarnessReasoner;
}

class WerewolfSocialTurnError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message);
    this.name = "WerewolfSocialTurnError";
  }
}

export class WerewolfSocialActorAdapter implements SocialActor<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand> {
  readonly id: string;
  readonly profile: SocialAgentProfile;
  private readonly turnTraces = new Map<string, HarnessTurnTrace>();
  private latest?: {
    observation: Extract<WerewolfSocialObservation, { kind: "player" }>;
    traceId: string;
    turnIndex: number;
  };
  private localTurnIndex = 0;

  constructor(readonly options: WerewolfSocialActorAdapterOptions) {
    this.id = options.actor.state.playerId;
    this.profile = {
      id: options.actor.state.profileId ?? options.actor.state.playerId,
      model: options.actor.state.model,
      temperature: options.actor.state.temperature,
      policyId: options.actor.state.policyName
    };
  }

  get state(): AgentHarnessState {
    return this.options.actor.state;
  }

  observe(observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    if (observation.kind !== "player") {
      throw new Error(`Werewolf social actor ${this.id} cannot observe ${observation.kind} observation.`);
    }
    if (observation.agentId !== this.id) {
      throw new Error(`Werewolf social actor ${this.id} received observation for ${observation.agentId}.`);
    }
    const turnIndex = context?.actorTurnIndex ?? (context?.traceId ? context.turnIndex : this.localTurnIndex + 1);
    const traceId = context?.traceId ?? `${this.options.tracePrefix ?? observation.view.gameId}:social-adapter:${turnIndex}:${this.id}:${observation.view.phase}`;
    this.localTurnIndex = Math.max(this.localTurnIndex, turnIndex);
    this.latest = { observation, traceId, turnIndex };
    this.options.actor.observe(observation.view, { traceId, turnIndex });
  }

  async decide(pending: WerewolfSocialPendingAction): Promise<SocialAction<GameCommand>> {
    if (!isAgentPendingAction(pending)) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide system pending action ${pending.kind}.`);
    }
    if (pending.actorId !== this.id) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide action for ${pending.actorId}.`);
    }
    if (!this.latest) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide before observing.`);
    }

    let plan = this.options.actor.plan(pending);
    try {
      const reasonerOutput = await this.options.reasoner.think({
        traceId: this.latest.traceId,
        view: cloneJson(this.latest.observation.view),
        action: cloneJson(pending),
        agent: toReasonerAgentContext(this.options.actor.state),
        policyPlan: cloneJson(plan)
      });
      if (pending.kind === "speech") {
        plan = attachSpeech(plan, normalizeSpeech(reasonerOutput.content));
      }
      this.options.actor.commitTurn(plan, reasonerOutput.content, {
        traceId: this.latest.traceId,
        turnIndex: this.latest.turnIndex,
        pendingAction: pending,
        providerRequestId: reasonerOutput.completion.providerRequestId
      });
      const command = this.options.actor.act(plan);
      const agentStateHash = this.options.actor.state.socialStateHash;
      const publicSpeech = command.type === "speech.submit" ? command.text : undefined;
      const trace: HarnessTurnTrace = {
        traceId: this.latest.traceId,
        playerId: this.id,
        profileId: this.options.actor.state.profileId,
        model: this.options.actor.state.model,
        actionKind: pending.kind,
        policyName: this.options.actor.state.policyName,
        commandType: command.type,
        intent: plan.intent,
        targetId: plan.targetId,
        confidence: plan.confidence,
        strategyTags: plan.strategyTags,
        arbitration: cloneJson(plan.arbitration),
        beliefs: cloneJson(this.options.actor.state.beliefs),
        privateMemo: reasonerOutput.content,
        publicSpeech,
        latencyMs: reasonerOutput.completion.latencyMs,
        promptTokens: reasonerOutput.completion.usage.promptTokens,
        completionTokens: reasonerOutput.completion.usage.completionTokens,
        providerRequestId: reasonerOutput.completion.providerRequestId,
        attempts: reasonerOutput.completion.attempts,
        retryHistory: cloneJson(reasonerOutput.completion.retryHistory),
        stream: cloneJson(reasonerOutput.completion.stream),
        agentStateHash
      };
      const reasonerSummary = summarizeReasonerOutput(reasonerOutput.content, reasonerOutput.completion);
      const metadata: WerewolfSocialActionMetadata = {
        kind: "werewolf-harness-turn",
        turnIndex: this.latest.turnIndex,
        policyPlan: cloneJson(plan),
        reasonerOutput: cloneJson(reasonerSummary),
        turnTrace: cloneJson(trace),
        agentStateHash
      };
      this.turnTraces.set(this.latest.traceId, trace);
      return {
        actorId: this.id,
        kind: command.type,
        traceId: this.latest.traceId,
        command,
        metadata: metadata as unknown as Record<string, unknown>,
        messages: createWerewolfMessageDrafts({
          players: this.options.players,
          traceId: this.latest.traceId,
          turnIndex: this.latest.turnIndex,
          actorId: this.id,
          pendingAction: pending,
          command,
          policyPlan: plan,
          observation: this.latest.observation.view,
          reasonerOutput: reasonerSummary
        })
      };
    } catch (error) {
      throw new WerewolfSocialTurnError(
        `Harness turn failed for ${this.id}/${this.options.actor.state.model}/${pending.kind}: ${describeError(error)}`,
        error
      );
    }
  }

  turnTraceFor(traceId: string | undefined): HarnessTurnTrace | undefined {
    if (!traceId) return undefined;
    return cloneJson(this.turnTraces.get(traceId));
  }
}

export class WerewolfSocialEnvironment
  implements SocialEnvironment<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>
{
  constructor(readonly environment: WerewolfEnvironment) {}

  static fromState(initialState: GameState): WerewolfSocialEnvironment {
    return new WerewolfSocialEnvironment(new WerewolfEnvironment(initialState));
  }

  snapshot(): GameState {
    return this.environment.snapshot();
  }

  pendingActions(): WerewolfSocialPendingAction[] {
    return this.environment.pendingActions();
  }

  observe(agentId: string, pending: WerewolfSocialPendingAction): WerewolfSocialObservation {
    if (!isAgentPendingAction(pending)) {
      throw new Error(`System pending action ${pending.kind} cannot be observed as a player action.`);
    }
    const view = this.environment.observe(agentId, pending);
    return {
      kind: "player",
      agentId,
      view: {
        ...view,
        social: {
          channels: [],
          messages: []
        }
      }
    };
  }

  step(command: GameCommand): GameState {
    return this.environment.step(command);
  }

  recordTurn(trace: HarnessTurnTrace): GameState {
    return this.environment.recordTurn(trace);
  }

  recordError(actorId: string, payload: HarnessErrorPayload): GameState {
    return this.environment.recordError(actorId, payload);
  }

  done(): boolean {
    return this.environment.done();
  }

  pending(): PendingAction[] {
    return this.environment.pending();
  }
}

export const assembleWerewolfSocialObservation: SocialObservationAssembler<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction
> = (context) => {
  if (context.environmentObservation.kind === "system") return context.environmentObservation;
  return {
    ...context.environmentObservation,
    view: {
      ...context.environmentObservation.view,
      social: {
        channels: context.visibleSocial.channels,
        messages: context.visibleSocial.messages
      }
    }
  };
};

export const werewolfSystemTransition: SocialSystemTransitionProvider<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  const pending = getPendingActions(context.state);
  if (pending.length !== 1 || pending[0].kind !== "advance") return undefined;
  const advance = pending[0];
  return {
    actorId: WEREWOLF_SYSTEM_ACTOR_ID,
    profileId: WEREWOLF_SYSTEM_PROFILE.id,
    pendingAction: advance,
    observation: {
      kind: "system",
      agentId: WEREWOLF_SYSTEM_ACTOR_ID,
      gameId: context.state.id,
      phase: context.state.phase,
      day: context.state.day,
      pendingAction: advance,
      social: {
        channels: [],
        messages: []
      }
    },
    action: systemAdvanceAction()
  };
};

export function createWerewolfSocialChannels(players: PlayerState[]): SocialChannel[] {
  const playerIds = players.map((player) => player.id);
  const wolfIds = players.filter((player) => player.team === "werewolves").map((player) => player.id);
  return [
    {
      id: "table",
      kind: "public",
      participantIds: playerIds,
      readableBy: "all"
    },
    {
      id: "werewolf-team",
      kind: "team",
      participantIds: wolfIds,
      readableBy: "participants"
    },
    ...players.map((player) => ({
      id: `private-${player.id}`,
      kind: "private" as const,
      participantIds: [player.id],
      readableBy: "participants" as const
    }))
  ];
}

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
          socialStateHash: restored.socialStateHash
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
            }
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
  const recordAgentSnapshots = options.recordAgentSnapshots ?? true;
  const actors = [...agentActors.values()].map(
    (actor) =>
      new WerewolfSocialActorAdapter({
        actor,
        reasoner: options.reasoner,
        players: initialState.players
      })
  );
  const channels = createWerewolfSocialChannels(initialState.players);
  const artifact = await runSocialEpisode({
    id: options.id ?? initialState.id,
    environment: WerewolfSocialEnvironment.fromState(initialState),
    actors,
    channels,
    initialMessages: cloneJson(options.initialSocialMessages ?? []),
    schedulerMode: options.schedulerMode ?? "aec",
    maxTransitions: options.maxTransitions,
    hashState: hashStableState,
    eventSeq: werewolfEventSeq,
    beforeEnvironmentStep: (context) => {
      recordWerewolfHarnessTurn(context);
      if (!recordAgentSnapshots) return;
      if (context.actorId === WEREWOLF_SYSTEM_ACTOR_ID) return;
      const traceId = context.action.traceId;
      if (!traceId) return;
      const agents = snapshotAgentStates(agentActors);
      agentSnapshotsByTraceId.set(traceId, {
        agents,
        hash: hashStableState(agents)
      });
    },
    assembleObservation: assembleWerewolfSocialObservation,
    systemTransition: werewolfSystemTransition,
    traceIdForDecision: options.traceIdForDecision ?? werewolfLegacyTraceId,
    actorTurnIndexForDecision: options.actorTurnIndexForDecision ?? createSequentialActorTurnIndexProvider(),
    schedulerModeForBatch: options.schedulerModeForBatch ?? werewolfLegacySchedulerModeForBatch,
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
    agentStates: [...agentActors.values()].map((actor) => cloneJson(actor.state)),
    channels: artifact.channels.map(cloneJson)
  };
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
    socialSteps: prefix.socialSteps,
    messages: prefix.artifact.messages,
    channels: prefix.channels,
    forkOf: options.forkOf
  });
}

export async function probeWerewolfSocialHarnessTurn(options: WerewolfHarnessTurnProbeOptions): Promise<{ trace: HarnessTurnTrace; command: GameCommand }> {
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
    visibleSocial: socialBus.observe(options.action.actorId),
    state: cloneJson(environment.snapshot())
  });
  const socialActor = new WerewolfSocialActorAdapter({
    actor,
    reasoner: options.reasoner,
    players: options.state.players
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
  return {
    trace,
    command: action.command
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
    const environment = new WerewolfEnvironment(initialState);
    const channels = createWerewolfSocialChannels(initialState.players);
    const socialBus = new SocialCommunicationBus(channels, cloneJson(options.initialSocialMessages ?? []));
    const failureReason = describeError(error);
    environment.recordError(WEREWOLF_SYSTEM_ACTOR_ID, {
      model: "unknown",
      actionKind: "initialize",
      message: failureReason,
      traceId: `${initialState.id}:harness:init`
    });
    return buildWerewolfHarnessRunResultFromParts({
      status: "failed",
      failureReason,
      initialState,
      finalState: environment.snapshot(),
      agentStates: [],
      trajectory: [],
      socialSteps: [],
      messages: socialBus.listMessages(),
      channels: socialBus.listChannels(),
      forkOf: options.forkOf
    });
  }
}

export function createWerewolfMessageDrafts(input: WerewolfMessageDraftInput): Array<Omit<SocialMessage, "id" | "seq" | "createdAt">> {
  const wolfIds = input.players.filter((player) => player.team === "werewolves").map((player) => player.id);
  const messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">> = [];
  const publicRecipientIds = input.players.filter((player) => player.id !== input.actorId).map((player) => player.id);
  const baseMetadata = {
    traceId: input.traceId,
    turnIndex: input.turnIndex,
    actionKind: input.pendingAction.kind,
    commandType: input.command.type
  };

  if (input.command.type === "speech.submit") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.text,
      metadata: {
        ...baseMetadata,
        kind: "public-speech",
        day: input.observation.day,
        claimedRole: input.command.claimedRole,
        pressureTargetId: input.command.pressureTargetId,
        strategyTags: input.command.strategyTags ?? []
      }
    });
  }

  if (input.command.type === "vote.cast") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.abstain ? `${input.actorId} abstained from the day vote.` : `${input.actorId} voted for ${input.command.targetId}.`,
      metadata: {
        ...baseMetadata,
        kind: "public-vote",
        day: input.observation.day,
        targetId: input.command.targetId,
        abstain: Boolean(input.command.abstain)
      }
    });
  }

  if (input.command.type === "hunter.shoot") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.targetId ? `${input.actorId} shot ${input.command.targetId}.` : `${input.actorId} declined to shoot.`,
      metadata: {
        ...baseMetadata,
        kind: "public-hunter-shot",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "werewolf.killVote") {
    messages.push({
      channelId: "werewolf-team",
      senderId: input.actorId,
      recipientIds: wolfIds.filter((wolfId) => wolfId !== input.actorId),
      visibility: "team",
      content: `${input.actorId} selected ${input.command.targetId} as the night kill target.`,
      metadata: {
        ...baseMetadata,
        kind: "werewolf-kill-vote",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "seer.inspect") {
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: `${input.actorId} inspected ${input.command.targetId}.`,
      metadata: {
        ...baseMetadata,
        kind: "private-seer-inspect",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "witch.act") {
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: `${input.actorId} submitted witch action.`,
      metadata: {
        ...baseMetadata,
        kind: "private-witch-action",
        saveTargetId: input.command.saveTargetId,
        poisonTargetId: input.command.poisonTargetId
      }
    });
  }

  if (input.reasonerOutput.content) {
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: input.reasonerOutput.content,
      metadata: {
        ...baseMetadata,
        kind: "private-reasoner-memo",
        latencyMs: input.reasonerOutput.latencyMs,
        promptTokens: input.reasonerOutput.promptTokens,
        completionTokens: input.reasonerOutput.completionTokens,
        providerRequestId: input.reasonerOutput.providerRequestId,
        attempts: input.reasonerOutput.attempts
      }
    });
  }

  return messages;
}

export function toWerewolfSocialStep(step: HarnessStepRecord, metadata: WerewolfSocialStepMetadata): WerewolfSocialStep {
  return {
    traceId: step.traceId,
    turnIndex: step.turnIndex,
    batchId: metadata.batchId,
    batchIndex: metadata.batchIndex,
    batchSize: metadata.batchSize,
    actorId: step.actorId,
    profileId: step.profileId ?? step.actorId,
    schedulerMode: metadata.schedulerMode,
    atomic: false,
    resolutionPolicy: metadata.resolutionPolicy,
    pendingAction: cloneJson(step.pendingAction),
    observation: cloneJson(step.observation),
    action: {
      actorId: step.actorId,
      kind: step.command.type,
      command: cloneJson(step.command)
    },
    decisionStateHash: step.decisionStateHash,
    preStateHash: step.preStateHash,
    postStateHash: step.postStateHash,
    actorSnapshotsAfterStep: cloneJson(step.agentSnapshotsAfterStep),
    actorSnapshotsHashAfterStep: step.agentSnapshotsHashAfterStep,
    eventSeqRange: step.eventSeqRange,
    messageSeqRange: step.messageSeqRange
  };
}

export function projectWerewolfSocialStepToHarnessStep(
  step: WerewolfGenericSocialStep,
  agentSnapshot?: AgentSnapshotAfterStep
): HarnessStepRecord | undefined {
  if (step.actorId === WEREWOLF_SYSTEM_ACTOR_ID) return undefined;
  if (step.error) return undefined;
  if (step.observation.kind !== "player") {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: expected player observation.`);
  }
  if (!isAgentPendingAction(step.pendingAction)) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: expected agent pending action.`);
  }
  if (!step.preStateHash) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing preStateHash.`);
  }
  if (!step.postStateHash) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing postStateHash.`);
  }
  if (!step.eventSeqRange) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing eventSeqRange.`);
  }
  const metadata = parseWerewolfSocialActionMetadata(step.action.metadata, step.traceId);
  const stepAgentSnapshot = agentSnapshot ?? agentSnapshotFromSocialStep(step);
  if (metadata.turnTrace.traceId !== step.traceId) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: turnTrace traceId mismatch.`);
  }
  if (metadata.turnTrace.playerId !== step.actorId) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: turnTrace actor mismatch.`);
  }
  if (metadata.turnTrace.commandType !== step.action.command.type) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: commandType mismatch.`);
  }
  return {
    traceId: step.traceId,
    turnIndex: metadata.turnIndex ?? step.turnIndex,
    actorId: step.actorId,
    profileId: step.profileId,
    model: metadata.turnTrace.model,
    pendingAction: cloneJson(step.pendingAction),
    observation: cloneJson(step.observation.view),
    decisionStateHash: step.decisionStateHash,
    preStateHash: step.preStateHash,
    policyPlan: cloneJson(metadata.policyPlan),
    reasonerOutput: cloneJson(metadata.reasonerOutput),
    command: cloneJson(step.action.command),
    turnTrace: cloneJson(metadata.turnTrace),
    agentStateHash: metadata.agentStateHash ?? metadata.turnTrace.agentStateHash,
    agentSnapshotsAfterStep: cloneJson(stepAgentSnapshot?.agents),
    agentSnapshotsHashAfterStep: stepAgentSnapshot?.hash,
    postStateHash: step.postStateHash,
    eventSeqRange: cloneJson(step.eventSeqRange),
    messageSeqRange: cloneJson(step.messageSeqRange)
  };
}

export function projectWerewolfSocialStepsToHarnessTrajectory(steps: WerewolfGenericSocialStep[]): HarnessStepRecord[] {
  return projectWerewolfSuccessfulSocialSteps(steps).map((step) => step.harnessStep);
}

export function assembleHarnessPlayerView(view: PlayerView, socialBus: SocialCommunicationBus): HarnessPlayerView {
  const social = socialBus.observe(view.you.id);
  return {
    ...cloneJson(view),
    social: {
      channels: social.channels,
      messages: social.messages
    }
  };
}

export function werewolfEventSeq(state: GameState): number {
  return state.events.at(-1)?.seq ?? 0;
}

export const werewolfLegacyTraceId: SocialTraceIdProvider<GameState, WerewolfSocialPendingAction> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return undefined;
  return `${context.state.id}:harness:${context.actorTurnIndex ?? context.turnIndex}:${context.actorId}:${context.state.phase}`;
};

export const werewolfLegacySchedulerModeForBatch: SocialSchedulerResolver<GameState, WerewolfSocialPendingAction> = (context) => {
  if (context.pendingActions.length > 0 && context.pendingActions.every((action) => action.kind === "vote" || action.kind === "kill")) {
    return "aec-batched-decision";
  }
  return "aec";
};

export const recordWerewolfDecisionFailure: SocialDecisionFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!(context.environment instanceof WerewolfSocialEnvironment)) {
    throw new Error("Werewolf decision failure recorder requires WerewolfSocialEnvironment.");
  }
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.environment.snapshot();
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const model = actor?.state.model ?? context.actor?.profile.model ?? "unknown";
  const traceId =
    context.traceId ??
    `${state.id}:harness:${context.actorTurnIndex ?? context.turnIndex}:${context.pendingAction.actorId}:${state.phase}`;
  const providerFailure = providerFailureFromError(context.error);
  context.environment.recordError(context.pendingAction.actorId, {
    model,
    actionKind: context.pendingAction.kind,
    message: describeError(context.error),
    traceId,
    ...(providerFailure ? { providerFailure } : {})
  });
};

export const recordWerewolfEnvironmentStepFailure: SocialEnvironmentStepFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!(context.environment instanceof WerewolfSocialEnvironment)) {
    throw new Error("Werewolf environment step failure recorder requires WerewolfSocialEnvironment.");
  }
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.environment.snapshot();
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const metadata = parseWerewolfSocialActionMetadataSafe(context.action.metadata, context.action.traceId);
  const model = metadata?.turnTrace.model ?? actor?.state.model ?? context.actor?.profile.model ?? "unknown";
  const actionKind = metadata?.turnTrace.actionKind ?? context.pendingAction.kind;
  const traceId =
    context.action.traceId ??
    metadata?.turnTrace.traceId ??
    `${state.id}:harness:${context.turnIndex}:${context.pendingAction.actorId}:${state.phase}`;
  const providerFailure = providerFailureFromError(context.error);
  const payload: HarnessErrorPayload = {
    model,
    actionKind,
    message: describeError(context.error),
    traceId
  };
  const providerRequestId = metadata?.reasonerOutput.providerRequestId;
  if (providerRequestId) payload.providerRequestId = providerRequestId;
  const attempts = metadata?.reasonerOutput.attempts;
  if (attempts !== undefined) payload.attempts = attempts;
  if (providerFailure) payload.providerFailure = providerFailure;
  context.environment.recordError(context.pendingAction.actorId, payload);
};

export function recordWerewolfHarnessTurn(
  context: SocialBeforeEnvironmentStepContext<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>
): void {
  if (context.actorId === WEREWOLF_SYSTEM_ACTOR_ID) return;
  if (!(context.environment instanceof WerewolfSocialEnvironment)) {
    throw new Error("Werewolf harness turn recorder requires WerewolfSocialEnvironment.");
  }
  if (!(context.actor instanceof WerewolfSocialActorAdapter)) {
    throw new Error(`Werewolf harness turn recorder requires WerewolfSocialActorAdapter for ${context.actorId}.`);
  }
  const trace = context.actor.turnTraceFor(context.action.traceId);
  if (!trace) {
    throw new Error(`Missing Werewolf harness turn trace for ${context.actorId}/${context.action.traceId ?? "unknown-trace"}.`);
  }
  context.environment.recordTurn(trace);
}

function systemAdvanceAction(): SocialAction<GameCommand> {
  return {
    actorId: WEREWOLF_SYSTEM_ACTOR_ID,
    kind: "system.advance",
    command: {
      type: "system.advance",
      actorId: WEREWOLF_SYSTEM_ACTOR_ID
    }
  };
}

function parseWerewolfSocialActionMetadata(metadata: unknown, traceId: string): WerewolfSocialActionMetadata {
  if (!isRecord(metadata) || metadata.kind !== "werewolf-harness-turn") {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing werewolf harness metadata.`);
  }
  if (!isRecord(metadata.policyPlan)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing policyPlan metadata.`);
  }
  if (!isRecord(metadata.reasonerOutput)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing reasonerOutput metadata.`);
  }
  if (!isRecord(metadata.turnTrace)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing turnTrace metadata.`);
  }
  return {
    kind: "werewolf-harness-turn",
    turnIndex: typeof metadata.turnIndex === "number" ? metadata.turnIndex : undefined,
    policyPlan: metadata.policyPlan as unknown as PolicyPlan,
    reasonerOutput: metadata.reasonerOutput as unknown as ReasonerOutputSummary,
    turnTrace: metadata.turnTrace as unknown as HarnessTurnTrace,
    agentStateHash: typeof metadata.agentStateHash === "string" ? metadata.agentStateHash : undefined
  };
}

function parseWerewolfSocialActionMetadataSafe(metadata: unknown, traceId: string | undefined): WerewolfSocialActionMetadata | undefined {
  try {
    return parseWerewolfSocialActionMetadata(metadata, traceId ?? "unknown-trace");
  } catch {
    return undefined;
  }
}

function projectWerewolfSuccessfulSocialSteps(
  steps: WerewolfGenericSocialStep[],
  agentSnapshotsByTraceId: Map<string, AgentSnapshotAfterStep> = new Map()
): Array<{ genericStep: WerewolfGenericSocialStep; harnessStep: HarnessStepRecord }> {
  return steps.flatMap((genericStep) => {
    const harnessStep = projectWerewolfSocialStepToHarnessStep(genericStep, agentSnapshotsByTraceId.get(genericStep.traceId));
    return harnessStep ? [{ genericStep, harnessStep }] : [];
  });
}

function attachAgentSnapshotsToSocialSteps(
  steps: WerewolfGenericSocialStep[],
  agentSnapshotsByTraceId: Map<string, AgentSnapshotAfterStep>
): void {
  for (const step of steps) {
    const snapshot = agentSnapshotsByTraceId.get(step.traceId);
    if (!snapshot) continue;
    step.actorSnapshotsAfterStep = cloneJson(snapshot.agents);
    step.actorSnapshotsHashAfterStep = snapshot.hash;
  }
}

function agentSnapshotFromSocialStep(step: WerewolfGenericSocialStep): AgentSnapshotAfterStep | undefined {
  if (!step.actorSnapshotsAfterStep || !step.actorSnapshotsHashAfterStep) return undefined;
  return {
    agents: step.actorSnapshotsAfterStep as AgentHarnessState[],
    hash: step.actorSnapshotsHashAfterStep
  };
}

function werewolfSocialStepSchedulerMode(mode: WerewolfGenericSocialStep["schedulerMode"]): WerewolfSocialStepMetadata["schedulerMode"] {
  if (mode === "parallel") {
    throw new Error("Parallel generic social steps cannot be converted to legacy Werewolf social steps.");
  }
  return mode;
}

function toWerewolfLegacySocialSteps(
  gameId: string,
  steps: Array<{ genericStep: WerewolfGenericSocialStep; harnessStep: HarnessStepRecord }>
): WerewolfSocialStep[] {
  const metadataFor = createWerewolfLegacySocialStepMetadataProvider(gameId);
  return steps.map(({ genericStep, harnessStep }) => toWerewolfSocialStep(harnessStep, metadataFor(genericStep)));
}

function createWerewolfLegacySocialStepMetadataProvider(gameId: string): (step: WerewolfGenericSocialStep) => WerewolfSocialStepMetadata {
  let nextLegacyBatchIndex = 1;
  const batchByGenericId = new Map<string, { batchId: string; nextBatchPosition: number }>();
  return (step) => {
    const metadata = socialStepMetadataFor(step);
    if (metadata.schedulerMode !== "aec-batched-decision") return metadata;
    const genericBatchId = step.batchId ?? `${step.traceId}:batch`;
    let batch = batchByGenericId.get(genericBatchId);
    if (!batch) {
      batch = {
        batchId: `${gameId}:werewolf-batch:${nextLegacyBatchIndex}`,
        nextBatchPosition: 1
      };
      batchByGenericId.set(genericBatchId, batch);
      nextLegacyBatchIndex += 1;
    }
    return {
      ...metadata,
      batchId: batch.batchId,
      batchIndex: batch.nextBatchPosition++,
      batchSize: step.batchSize
    };
  };
}

function socialStepMetadataFor(step: WerewolfGenericSocialStep): WerewolfSocialStepMetadata {
  const schedulerMode = werewolfSocialStepSchedulerMode(step.schedulerMode);
  return {
    schedulerMode,
    resolutionPolicy: step.resolutionPolicy ?? (schedulerMode === "aec-batched-decision" ? "sequential-apply-from-shared-decision-state" : "sequential-apply")
  };
}

function createSequentialActorTurnIndexProvider(): SocialActorTurnIndexProvider<GameState, WerewolfSocialPendingAction> {
  let nextTurnIndex = 1;
  return (context) => {
    if (!isAgentPendingAction(context.pendingAction)) return undefined;
    const turnIndex = nextTurnIndex;
    nextTurnIndex += 1;
    return turnIndex;
  };
}

function snapshotAgentStates(agentActors: Map<string, WerewolfAgentActor>): AgentHarnessState[] {
  return [...agentActors.values()].map((actor) => cloneJson(actor.state));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toReasonerAgentContext(agent: AgentHarnessState): ReasonerAgentContext {
  return {
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName,
    turns: agent.turns,
    observations: agent.observations,
    beliefs: cloneJson(agent.beliefs),
    lastIntent: agent.lastIntent,
    socialStateHash: agent.socialStateHash
  };
}

function normalizeSpeech(content: string): string {
  const text = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^【?公开发言】?[：:]\s*/u, "")
    .trim();
  if (text.length < 20) {
    throw new Error("Speech reasoner output is too short to submit as a public speech.");
  }
  return text.slice(0, 500);
}

function summarizeReasonerOutput(
  content: string,
  completion: {
    latencyMs: number;
    usage?: { promptTokens?: number; completionTokens?: number };
    providerRequestId?: string;
    attempts?: number;
    retryHistory?: ReasonerOutputSummary["retryHistory"];
    stream?: ReasonerOutputSummary["stream"];
  }
): ReasonerOutputSummary {
  return {
    content,
    latencyMs: completion.latencyMs,
    promptTokens: completion.usage?.promptTokens,
    completionTokens: completion.usage?.completionTokens,
    providerRequestId: completion.providerRequestId,
    attempts: completion.attempts,
    retryHistory: cloneJson(completion.retryHistory),
    stream: cloneJson(completion.stream)
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
