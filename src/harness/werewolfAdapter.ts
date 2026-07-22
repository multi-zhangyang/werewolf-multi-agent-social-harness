import { getPendingActions } from "../core/engine";
import { isAgentPendingAction } from "../core/pending";
import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState, PendingAction, Phase, PlayerState, PlayerView } from "../core/types";
import {
  WerewolfAgentActor,
  applyWerewolfReasonerProposal,
  commitWerewolfAgentTurn,
  type WerewolfAgentObserveContext
} from "./actor";
import { hashStableState } from "./hash";
import { attachSpeech, planAction, policyForRole } from "./policy";
import type {
  SocialAction,
  SocialActionValidationResult,
  SocialActor,
  SocialActorObservationContext,
  SocialActorStepReceipt,
  SocialAgentProfile,
  SocialActorTurnIndexProvider,
  SocialChannel,
  SocialDecisionFailureHook,
  SocialEnvironment,
  SocialEnvironmentStepFailureHook,
  SocialParallelEnvironment,
  SocialEpisodeArtifact,
  SocialHarnessStep,
  SocialMessage,
  SocialObservationAssembler,
  SocialSchedulerResolver,
  SocialSpeechAct,
  SocialSystemTransition,
  SocialSystemTransitionProvider,
  SocialTraceIdProvider
} from "./social";
import { SocialCommunicationBus } from "./social";
import { runHarnessEpisode } from "./runner";
import {
  createScaffoldedActor,
  type AgentDecisionInput,
  type AgentPolicy,
  type AgentReasoner,
  type ScaffoldCanonicalStateAdapter,
  type ScaffoldedSocialActor
} from "./scaffold";
import { createAgentSocialState } from "./socialState";
import { describeError, providerFailureFromError } from "./providerFailure";
import {
  WEREWOLF_HARNESS_TURN_METADATA_KIND,
  parseWerewolfHarnessTurnActionMetadata,
  tryParseWerewolfHarnessTurnActionMetadata,
  type WerewolfHarnessTurnActionMetadata
} from "./werewolfExecutionEvidence";
import {
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  type AgentHarnessState,
  type HarnessAgentConfig,
  type HarnessErrorPayload,
  type HarnessPlayerView,
  type HarnessReasoner,
  type HarnessRunOptions,
  type HarnessRunResult,
  type HarnessStepRecord,
  type HarnessTurnTrace,
  type PolicyPlan,
  type ReasonerAgentContext,
  type ReasonerMemoryEntry,
  type ReasonerOutput,
  type ReasonerOutputSummary,
  type WerewolfHarnessObservation
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

export type WerewolfSocialObservation = WerewolfHarnessObservation;

export interface WerewolfSocialActorAdapterOptions {
  actor: WerewolfAgentActor;
  reasoner: HarnessReasoner;
  players: PlayerState[];
  tracePrefix?: string;
  /**
   * The production path uses the generic receipt-gated scaffold with the
   * canonical AgentHarnessState bridge. Legacy mode remains only for direct
   * compatibility tests and migration parity baselines.
   */
  executionMode?: "legacy" | "scaffold";
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

export type WerewolfSocialActionMetadata = WerewolfHarnessTurnActionMetadata;

export interface WerewolfSocialStepMetadata {
  schedulerMode: "aec" | "aec-batched-decision" | "parallel";
  resolutionPolicy: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
}

export type WerewolfSocialHarnessPrefixSchedulerMode = "aec" | "aec-batched-decision" | "simultaneous-batch" | "parallel";

export interface WerewolfSocialHarnessPrefixOptions
  extends Pick<
    HarnessRunOptions,
    | "initialState"
    | "agents"
    | "initialAgentStates"
    | "initialSocialChannels"
    | "initialSocialMessages"
    | "reasoner"
    | "maxTransitions"
    | "executionLimits"
    | "jointPhaseScheduler"
    | "recordAgentSnapshots"
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
  private readonly scaffolded?: ScaffoldedSocialActor<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >;
  private readonly turnTraces = new Map<string, HarnessTurnTrace>();
  private readonly pendingProposals = new Map<
    string,
    {
      /**
       * Runner-owned action trace evidence. This deliberately remains
       * separate from the map key: a runner can reject a decision using its
       * own scheduler trace while retaining the policy trace in the rejected
       * action evidence.
       */
      traceId: string;
      plan: PolicyPlan;
      privateMemo: string;
      pendingAction: AgentPendingAction;
      providerRequestId?: string;
      expectedAgentStateHash: string;
    }
  >();
  private readonly stagedActors = new Map<string, WerewolfAgentActor>();
  private latest?: {
    observation: Extract<WerewolfSocialObservation, { kind: "player" }>;
    traceId: string;
    transactionId: string;
    turnIndex: number;
    receiptTurnIndex: number;
    actor: WerewolfAgentActor;
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
    if (options.executionMode === "scaffold") {
      if (options.tracePrefix) {
        throw new Error("Scaffolded Werewolf actors do not support tracePrefix; use runner-owned trace identity.");
      }
      this.scaffolded = createScaffoldedWerewolfActor({
        id: this.id,
        profile: this.profile,
        initialState: options.actor.state,
        reasoner: options.reasoner,
        players: options.players
      });
    }
  }

  get state(): AgentHarnessState {
    return this.scaffolded ? this.scaffolded.state : this.options.actor.state;
  }

  observe(observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    if (this.scaffolded) {
      this.scaffolded.observe(observation, context);
      return;
    }
    if (observation.kind !== "player") {
      throw new Error(`Werewolf social actor ${this.id} cannot observe ${observation.kind} observation.`);
    }
    if (observation.agentId !== this.id) {
      throw new Error(`Werewolf social actor ${this.id} received observation for ${observation.agentId}.`);
    }
    const turnIndex = this.options.tracePrefix
      ? this.localTurnIndex + 1
      : context?.actorTurnIndex ?? (context?.traceId ? context.turnIndex : this.localTurnIndex + 1);
    const traceId = this.options.tracePrefix
      ? `${this.options.tracePrefix}:social-adapter:${turnIndex}:${this.id}:${observation.view.phase}`
      : context?.traceId ?? `werewolf:social-adapter:${turnIndex}:${this.id}:${observation.view.phase}`;
    const transactionId = context?.transactionId ?? context?.traceId ?? traceId;
    this.localTurnIndex = Math.max(this.localTurnIndex, turnIndex);
    const stagedActor = context?.transactional === true ? new WerewolfAgentActor(cloneJson(this.options.actor.state)) : this.options.actor;
    stagedActor.observe(observation.view, { traceId, turnIndex });
    if (context?.transactional === true) this.stagedActors.set(transactionId, stagedActor);
    this.latest = {
      observation,
      traceId,
      transactionId,
      turnIndex,
      receiptTurnIndex: context?.turnIndex ?? turnIndex,
      actor: stagedActor
    };
  }

  async decide(pending: WerewolfSocialPendingAction): Promise<SocialAction<GameCommand>> {
    if (this.scaffolded) {
      try {
        const action = await this.scaffolded.decide(pending);
        const metadata = parseWerewolfHarnessTurnActionMetadata(action.metadata, action.traceId ?? `${this.id}:missing-trace`);
        this.turnTraces.set(metadata.turnTrace.traceId, cloneJson(metadata.turnTrace));
        return action;
      } catch (error) {
        throw new WerewolfSocialTurnError(
          `Harness turn failed for ${this.id}/${this.state.model}/${pending.kind}: ${describeError(error)}`,
          error
        );
      }
    }
    if (!isAgentPendingAction(pending)) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide system pending action ${pending.kind}.`);
    }
    if (pending.actorId !== this.id) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide action for ${pending.actorId}.`);
    }
    if (!this.latest) {
      throw new Error(`Werewolf social actor ${this.id} cannot decide before observing.`);
    }

    const stagedActor = this.latest.actor;
    let plan = stagedActor.plan(pending);
    try {
      const reasonerInput = {
        traceId: this.latest.traceId,
        view: cloneJson(this.latest.observation.view),
        action: cloneJson(pending),
        agent: toReasonerAgentContext(stagedActor.state),
        policyPlan: cloneJson(plan),
        memoryRetrieval: cloneJson(plan.memoryRetrieval),
        recalledMemory: stagedActor.reasonerMemoryEntries(plan.memoryRetrieval)
      };
      const reasonerOutput = await this.options.reasoner.think(reasonerInput);
      const actionProposal = reasonerOutput.actionProposal;
      plan = stagedActor.applyReasonerProposal(plan, pending, actionProposal);
      if (pending.kind === "speech" || pending.kind === "last_words" || pending.kind === "whisper") {
        plan = attachSpeech(plan, normalizeSpeech(reasonerOutput.content));
      }
      const command = stagedActor.act(plan);
      const publicSpeech = command.type === "speech.submit" || command.type === "lastWords.submit" ? command.text : undefined;
      const commitContext = {
        traceId: this.latest.traceId,
        turnIndex: this.latest.receiptTurnIndex,
        pendingAction: cloneJson(pending),
        providerRequestId: reasonerOutput.completion.providerRequestId
      };
      const expectedAgentStateHash = stagedActor.previewCommittedStateHash(plan, reasonerOutput.content, commitContext);
      const trace: HarnessTurnTrace = {
        traceId: this.latest.traceId,
        playerId: this.id,
        profileId: stagedActor.state.profileId,
        model: stagedActor.state.model,
        actionKind: pending.kind,
        policyName: stagedActor.state.policyName,
        commandType: command.type,
        intent: plan.intent,
        targetId: plan.targetId,
        confidence: plan.confidence,
        strategyTags: plan.strategyTags,
        arbitration: cloneJson(plan.arbitration),
        memoryRetrieval: cloneJson(plan.memoryRetrieval),
        beliefs: cloneJson(stagedActor.state.beliefs),
        privateMemo: reasonerOutput.content,
        publicSpeech,
        latencyMs: reasonerOutput.completion.latencyMs,
        promptTokens: reasonerOutput.completion.usage.promptTokens,
        completionTokens: reasonerOutput.completion.usage.completionTokens,
        providerRequestId: reasonerOutput.completion.providerRequestId,
        attempts: reasonerOutput.completion.attempts,
        retryHistory: cloneJson(reasonerOutput.completion.retryHistory),
        stream: cloneJson(reasonerOutput.completion.stream),
        agentStateHash: expectedAgentStateHash
      };
      const reasonerSummary = summarizeReasonerOutput(
        reasonerOutput.content,
        reasonerOutput.completion,
        actionProposal
      );
      const metadata: WerewolfSocialActionMetadata = {
        kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
        turnIndex: this.latest.turnIndex,
        policyPlan: cloneJson(plan),
        reasonerOutput: cloneJson(reasonerSummary),
        turnTrace: cloneJson(trace),
        agentStateHash: expectedAgentStateHash
      };
      this.turnTraces.set(this.latest.traceId, trace);
      // Private turn state is transaction-scoped, never action-trace-scoped.
      // In particular, a scheduler-level rejection can deliver a unique
      // runner trace id that differs from the policy-provided trace id.
      this.pendingProposals.set(this.latest.transactionId, {
        traceId: this.latest.traceId,
        plan: cloneJson(plan),
        privateMemo: reasonerOutput.content,
        pendingAction: cloneJson(pending),
        providerRequestId: reasonerOutput.completion.providerRequestId,
        expectedAgentStateHash
      });
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

  onStepResult(receipt: SocialActorStepReceipt<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>): void {
    if (this.scaffolded) {
      this.scaffolded.onStepResult(receipt);
      if (receipt.status !== "committed" && receipt.action?.metadata) {
        const metadata = tryParseWerewolfHarnessTurnActionMetadata(receipt.action.metadata, receipt.action.traceId);
        if (metadata) this.turnTraces.delete(metadata.turnTrace.traceId);
      }
      return;
    }
    const transactionId = receipt.transactionId ?? receipt.traceId;
    const stagedActor = this.stagedActors.get(transactionId);
    this.stagedActors.delete(transactionId);
    const proposal = this.pendingProposals.get(transactionId);
    this.pendingProposals.delete(transactionId);
    if (!proposal || !stagedActor || receipt.status !== "committed") {
      // A proposal/trace is only durable after a committed receipt. Clearing
      // the speculative trace prevents rejected trace-collision decisions
      // from accumulating actor-private state.
      if (proposal) this.turnTraces.delete(proposal.traceId);
      return;
    }
    if (receipt.traceId !== proposal.traceId) {
      throw new Error(
        `Committed receipt trace mismatch for ${this.id}: expected ${proposal.traceId}, received ${receipt.traceId}.`
      );
    }

    stagedActor.commitTurn(proposal.plan, proposal.privateMemo, {
      traceId: proposal.traceId,
      turnIndex: receipt.turnIndex,
      pendingAction: proposal.pendingAction,
      providerRequestId: proposal.providerRequestId
    });
    const agentStateHash = stagedActor.state.socialStateHash;
    if (agentStateHash !== proposal.expectedAgentStateHash) {
      throw new Error(
        `Committed agent state hash mismatch for ${this.id}: expected ${proposal.expectedAgentStateHash}, received ${agentStateHash}.`
      );
    }
    replaceAgentHarnessState(this.options.actor.state, stagedActor.state);
  }

  turnTraceFor(traceId: string | undefined): HarnessTurnTrace | undefined {
    if (!traceId) return undefined;
    return cloneJson(this.turnTraces.get(traceId));
  }
}

/**
 * Production bridge: `AgentHarnessState` is the only durable private state.
 * The generic scaffold owns speculative cloning, candidate sequencing, and
 * receipt-gated replacement; these domain callbacks only reduce/commit that
 * one canonical state and project existing Werewolf evidence envelopes.
 */
function createScaffoldedWerewolfActor(input: {
  id: string;
  profile: SocialAgentProfile;
  initialState: AgentHarnessState;
  reasoner: HarnessReasoner;
  players: PlayerState[];
}): ScaffoldedSocialActor<
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand,
  AgentHarnessState,
  ReasonerOutput
> {
  const stateAdapter: ScaffoldCanonicalStateAdapter<
    AgentHarnessState,
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    ReasonerOutput
  > = {
    clone: cloneJson,
    socialState: (state) => {
      if (!state.social) throw new Error(`Scaffolded Werewolf actor ${state.playerId} is missing canonical social state.`);
      return state.social as unknown as import("./socialState").AgentSocialState<
        WerewolfSocialObservation,
        WerewolfSocialPendingAction,
        GameCommand
      >;
    },
    observe: ({ state, observation, context }) => {
      const playerTurn = requireScaffoldedWerewolfPlayerTurn({ observation, pending: context?.pendingAction, context });
      new WerewolfAgentActor(state).observe(playerTurn.view, playerTurn.observeContext);
    },
    afterDecision: ({ state, observation, pendingAction, action, context }) => {
      const playerTurn = requireScaffoldedWerewolfPlayerTurn({ observation, pending: pendingAction, context });
      const metadata = parseWerewolfHarnessTurnActionMetadata(action.metadata, action.traceId ?? `${state.playerId}:missing-trace`);
      if (metadata.turnTrace.playerId !== state.playerId || metadata.policyPlan.command.type !== action.command.type) {
        throw new Error(`Scaffolded Werewolf action metadata does not match canonical actor ${state.playerId}.`);
      }
      const reasonerOutput = metadata.reasonerOutput;
      commitWerewolfAgentTurn({
        state,
        view: playerTurn.view,
        observeContext: playerTurn.observeContext,
        plan: cloneJson(metadata.policyPlan),
        privateMemo: metadata.turnTrace.privateMemo,
        context: {
          traceId: metadata.turnTrace.traceId,
          turnIndex: playerTurn.receiptTurnIndex,
          pendingAction: cloneJson(playerTurn.pending),
          providerRequestId: reasonerOutput.providerRequestId
        }
      });
      if (state.socialStateHash !== metadata.agentStateHash) {
        throw new Error(
          `Scaffolded Werewolf committed agent state hash mismatch for ${state.playerId}: expected ${metadata.agentStateHash}, received ${state.socialStateHash}.`
        );
      }
    }
  };
  const policy: AgentPolicy<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  > = {
    id: `werewolf-policy:${input.initialState.policyName}`,
    decide: (decision) => buildScaffoldedWerewolfAction({ decision, players: input.players })
  };
  const reasoner: AgentReasoner<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  > = {
    id: "werewolf-harness-reasoner",
    async reflect(decision) {
      const playerTurn = requireScaffoldedWerewolfPlayerTurn({
        observation: decision.observation,
        pending: decision.pendingAction,
        context: decision.observationContext
      });
      const policyPlan = werewolfPolicyPlanForScaffoldDecision(decision, playerTurn);
      const output = await input.reasoner.think({
        traceId: playerTurn.traceId,
        view: cloneJson(playerTurn.view),
        action: cloneJson(playerTurn.pending),
        agent: toReasonerAgentContext(decision.agent),
        policyPlan: cloneJson(policyPlan),
        memoryRetrieval: cloneJson(decision.memoryRetrieval),
        recalledMemory: scaffoldReasonerMemoryEntries(decision)
      });
      return {
        memo: output.content,
        advice: cloneJson(output)
      };
    }
  };
  return createScaffoldedActor({
    id: input.id,
    profile: input.profile,
    policy,
    reasoner,
    initialCanonicalState: cloneJson(input.initialState),
    canonicalStateAdapter: stateAdapter
  });
}

function buildScaffoldedWerewolfAction(input: {
  decision: AgentDecisionInput<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >;
  players: PlayerState[];
}): SocialAction<GameCommand> {
  const playerTurn = requireScaffoldedWerewolfPlayerTurn({
    observation: input.decision.observation,
    pending: input.decision.pendingAction,
    context: input.decision.observationContext
  });
  const reasonerOutput = input.decision.reasoner?.advice;
  if (!reasonerOutput) {
    throw new Error(`Scaffolded Werewolf actor ${input.decision.agent.playerId} requires reasoner output before policy action selection.`);
  }
  let plan = werewolfPolicyPlanForScaffoldDecision(input.decision, playerTurn);
  plan = applyWerewolfReasonerProposal(plan, playerTurn.pending, reasonerOutput.actionProposal);
  if (playerTurn.pending.kind === "speech" || playerTurn.pending.kind === "last_words" || playerTurn.pending.kind === "whisper") {
    plan = attachSpeech(plan, normalizeSpeech(reasonerOutput.content));
  }
  const command = plan.command;
  const commitContext = {
    traceId: playerTurn.traceId,
    turnIndex: playerTurn.receiptTurnIndex,
    pendingAction: cloneJson(playerTurn.pending),
    providerRequestId: reasonerOutput.completion.providerRequestId
  };
  const preview = cloneJson(input.decision.agent);
  commitWerewolfAgentTurn({
    state: preview,
    view: playerTurn.view,
    observeContext: playerTurn.observeContext,
    plan: cloneJson(plan),
    privateMemo: reasonerOutput.content,
    context: commitContext
  });
  const expectedAgentStateHash = preview.socialStateHash;
  if (!expectedAgentStateHash) throw new Error(`Scaffolded Werewolf actor ${preview.playerId} did not produce an agent state hash.`);
  const publicSpeech = command.type === "speech.submit" || command.type === "lastWords.submit" ? command.text : undefined;
  const trace: HarnessTurnTrace = {
    traceId: playerTurn.traceId,
    playerId: preview.playerId,
    profileId: preview.profileId,
    model: preview.model,
    actionKind: playerTurn.pending.kind,
    policyName: preview.policyName,
    commandType: command.type,
    intent: plan.intent,
    targetId: plan.targetId,
    confidence: plan.confidence,
    strategyTags: plan.strategyTags,
    arbitration: cloneJson(plan.arbitration),
    memoryRetrieval: cloneJson(plan.memoryRetrieval),
    beliefs: cloneJson(preview.beliefs),
    privateMemo: reasonerOutput.content,
    publicSpeech,
    latencyMs: reasonerOutput.completion.latencyMs,
    promptTokens: reasonerOutput.completion.usage.promptTokens,
    completionTokens: reasonerOutput.completion.usage.completionTokens,
    providerRequestId: reasonerOutput.completion.providerRequestId,
    attempts: reasonerOutput.completion.attempts,
    retryHistory: cloneJson(reasonerOutput.completion.retryHistory),
    stream: cloneJson(reasonerOutput.completion.stream),
    agentStateHash: expectedAgentStateHash
  };
  const reasonerSummary = summarizeReasonerOutput(reasonerOutput.content, reasonerOutput.completion, reasonerOutput.actionProposal);
  const metadata: WerewolfSocialActionMetadata = {
    kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
    turnIndex: playerTurn.actorTurnIndex,
    policyPlan: cloneJson(plan),
    reasonerOutput: cloneJson(reasonerSummary),
    turnTrace: cloneJson(trace),
    agentStateHash: expectedAgentStateHash
  };
  return {
    actorId: preview.playerId,
    kind: command.type,
    traceId: playerTurn.traceId,
    command: cloneJson(command),
    metadata: metadata as unknown as Record<string, unknown>,
    messages: createWerewolfMessageDrafts({
      players: input.players,
      traceId: playerTurn.traceId,
      turnIndex: playerTurn.actorTurnIndex,
      actorId: preview.playerId,
      pendingAction: playerTurn.pending,
      command,
      policyPlan: plan,
      observation: playerTurn.view,
      reasonerOutput: reasonerSummary
    })
  };
}

function werewolfPolicyPlanForScaffoldDecision(
  decision: AgentDecisionInput<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >,
  playerTurn: ReturnType<typeof requireScaffoldedWerewolfPlayerTurn>
): PolicyPlan {
  return {
    ...planAction(playerTurn.view, playerTurn.pending, decision.agent),
    memoryRetrieval: cloneJson(decision.memoryRetrieval)
  };
}

function scaffoldReasonerMemoryEntries(
  decision: AgentDecisionInput<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >
): ReasonerMemoryEntry[] {
  return (decision.recalledMemory ?? []).map((entry) => ({
    memorySeq: entry.seq,
    kind: entry.kind,
    source: entry.source,
    visibility: entry.visibility,
    tags: [...entry.tags],
    content: entry.content ? entry.content.slice(0, 480) : undefined
  }));
}

function requireScaffoldedWerewolfPlayerTurn(input: {
  observation: WerewolfSocialObservation;
  pending: WerewolfSocialPendingAction | undefined;
  context: SocialActorObservationContext<WerewolfSocialPendingAction> | undefined;
}): {
  view: HarnessPlayerView;
  pending: AgentPendingAction;
  traceId: string;
  actorTurnIndex: number;
  receiptTurnIndex: number;
  observeContext: WerewolfAgentObserveContext;
} {
  if (input.observation.kind !== "player") {
    throw new Error(`Scaffolded Werewolf actor cannot observe ${input.observation.kind} observation.`);
  }
  const pending = input.pending;
  if (!pending || !isAgentPendingAction(pending) || pending.actorId !== input.observation.agentId) {
    throw new Error(`Scaffolded Werewolf actor ${input.observation.agentId} received an invalid pending action.`);
  }
  const context = input.context;
  if (!context?.traceId) throw new Error(`Scaffolded Werewolf actor ${input.observation.agentId} requires a runner traceId.`);
  const traceId = context.traceId;
  const actorTurnIndex = context.actorTurnIndex ?? context.turnIndex;
  return {
    view: input.observation.view,
    pending: cloneJson(pending),
    traceId,
    actorTurnIndex,
    receiptTurnIndex: context.turnIndex,
    observeContext: { traceId, turnIndex: actorTurnIndex }
  };
}

export class WerewolfSocialEnvironment
  implements
    SocialEnvironment<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>,
    SocialParallelEnvironment<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>
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

  validateAction(command: GameCommand, pending: WerewolfSocialPendingAction): SocialActionValidationResult {
    if (pending.kind === "advance" && command.type !== "system.advance") {
      return {
        valid: false,
        code: "pending-kind-mismatch",
        message: `Command ${command.type} cannot resolve system pending action ${pending.kind}.`
      };
    }
    if (pending.kind !== "advance" && command.type === "system.advance") {
      return {
        valid: false,
        code: "pending-kind-mismatch",
        message: `System advance cannot resolve agent pending action ${pending.kind}.`
      };
    }
    if (pending.actorId && command.actorId !== pending.actorId) {
      return {
        valid: false,
        code: "actor-mismatch",
        message: `Command actor ${command.actorId} does not match pending actor ${pending.actorId}.`
      };
    }
    return this.environment.validate(command);
  }

  stepBatch(commandsByAgent: Record<string, GameCommand>): GameState {
    return this.environment.stepBatch(commandsByAgent);
  }

  done(): boolean {
    return this.environment.done();
  }

  pending(): PendingAction[] {
    return this.environment.pending();
  }
}

export const assembleWerewolfSocialObservation: SocialObservationAssembler<
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
        players: initialState.players,
        executionMode: "scaffold"
      })
  );
  const channels = cloneJson(options.initialSocialChannels ?? createWerewolfSocialChannels(initialState.players));
  const artifact = await runHarnessEpisode({
    id: options.id ?? initialState.id,
    domainId: "werewolf",
    environment: WerewolfSocialEnvironment.fromState(initialState),
    actors,
    channels,
    initialMessages: cloneJson(options.initialSocialMessages ?? []),
    schedulerMode: options.schedulerMode ?? "aec",
    maxTransitions: options.maxTransitions,
    executionLimits: options.executionLimits,
    hashState: hashStableState,
    hashMessages: hashStableState,
    eventSeq: werewolfEventSeq,
    afterEnvironmentStep: (context) => {
      if (!recordAgentSnapshots) return;
      if (context.actorId === WEREWOLF_SYSTEM_ACTOR_ID) return;
      const traceId = context.action.traceId;
      if (!traceId) return;
      const agents = snapshotAgentStates(actors);
      agentSnapshotsByTraceId.set(traceId, {
        agents,
        hash: hashStableState(agents)
      });
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
    visibleSocial: socialBus.observe(options.action.actorId)
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
          initialMessagesHash: hashStableState(socialBus.listMessages())
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
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

  if (input.command.type === "lastWords.submit") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.text,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "public-last-words",
        day: input.observation.day
      }
    });
  }

  if (input.command.type === "sheriff.vote") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.abstain
        ? `${input.actorId} abstained from the sheriff election.`
        : `${input.actorId} voted for ${input.command.targetId} in the sheriff election.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "public-sheriff-vote",
        day: input.observation.day,
        targetId: input.command.targetId,
        abstain: Boolean(input.command.abstain)
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "werewolf-kill-vote",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "werewolf.whisper") {
    messages.push({
      channelId: "werewolf-team",
      senderId: input.actorId,
      recipientIds: wolfIds.filter((wolfId) => wolfId !== input.actorId),
      visibility: "team",
      content: input.command.text,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "werewolf-whisper",
        day: input.observation.day,
        strategyTags: input.command.strategyTags ?? []
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
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
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
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

function werewolfSpeechActsForCommand(command: GameCommand, actorId: string): SocialSpeechAct[] | undefined {
  const evidenceRefs: SocialSpeechAct["evidenceRefs"] = [];

  if (command.type === "speech.submit") {
    const acts: SocialSpeechAct[] = [];
    if (command.claimedRole) {
      acts.push({
        id: "",
        kind: "role_claim",
        subjectId: actorId,
        value: command.claimedRole,
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.claimedRole", messageKind: "public-speech" }
      });
    }
    if (command.pressureTargetId) {
      acts.push({
        id: "",
        kind: "accusation",
        subjectId: actorId,
        targetId: command.pressureTargetId,
        value: "pressure_target",
        confidence: 0.8,
        evidenceRefs,
        metadata: { source: "metadata.pressureTargetId", messageKind: "public-speech" }
      });
    }
    return acts.length ? acts : undefined;
  }

  if (command.type === "lastWords.submit") {
    return [
      {
        id: "",
        kind: "statement",
        subjectId: actorId,
        value: "last_words",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "last_words", messageKind: "public-last-words" }
      }
    ];
  }

  if (command.type === "sheriff.vote") {
    return [
      {
        id: "",
        kind: "vote_intent",
        subjectId: actorId,
        targetId: command.targetId,
        value: command.abstain ? "sheriff.vote.abstain" : "sheriff.vote",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", abstain: Boolean(command.abstain), messageKind: "public-sheriff-vote" }
      }
    ];
  }

  if (command.type === "vote.cast") {
    return [
      {
        id: "",
        kind: "vote_intent",
        subjectId: actorId,
        targetId: command.targetId,
        value: command.abstain ? "vote.abstain" : "vote.cast",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", abstain: Boolean(command.abstain), messageKind: "public-vote" }
      }
    ];
  }

  if (command.type === "hunter.shoot") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.targetId,
        value: "hunter.shoot",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "public-hunter-shot" }
      }
    ];
  }

  if (command.type === "werewolf.killVote") {
    return [
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actorId,
        targetId: command.targetId,
        value: "werewolf.killVote",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "werewolf-kill-vote" }
      }
    ];
  }

  if (command.type === "werewolf.whisper") {
    return [
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actorId,
        value: "werewolf.whisper",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "werewolf.whisper", messageKind: "werewolf-whisper" }
      }
    ];
  }

  if (command.type === "seer.inspect") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.targetId,
        value: "seer.inspect",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "private-seer-inspect" }
      }
    ];
  }

  if (command.type === "witch.act") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.poisonTargetId ?? command.saveTargetId,
        value: "witch.act",
        confidence: 1,
        evidenceRefs,
        metadata: {
          source: "metadata.kind",
          messageKind: "private-witch-action",
          hasSave: Boolean(command.saveTargetId),
          hasPoison: Boolean(command.poisonTargetId)
        }
      }
    ];
  }

  return undefined;
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
  const metadata = parseWerewolfHarnessTurnActionMetadata(step.action.metadata, step.traceId);
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

// werewolfLegacySchedulerModeForBatch is defined below createWerewolfJointPhaseSchedulerResolver.

export const recordWerewolfDecisionFailure: SocialDecisionFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.decisionState;
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const model = actor?.state.model ?? context.actor?.profile.model ?? "unknown";
  const traceId =
    context.traceId ??
    `${state.id}:harness:${context.actorTurnIndex ?? context.turnIndex}:${context.pendingAction.actorId}:${state.phase}`;
  const providerFailure = providerFailureFromError(context.error);
  const payload: HarnessErrorPayload = {
    model,
    actionKind: context.pendingAction.kind,
    message: describeError(context.error),
    traceId,
    ...(providerFailure ? { providerFailure } : {})
  };
  return {
    stage: context.failureStage,
    message: payload.message,
    causeName: context.error instanceof Error ? context.error.name : undefined,
    metadata: payload
  };
};

export const recordWerewolfEnvironmentStepFailure: SocialEnvironmentStepFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.failureState;
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const metadata = tryParseWerewolfHarnessTurnActionMetadata(context.action.metadata, context.action.traceId);
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
  return {
    stage: "environment_step",
    message: payload.message,
    causeName: context.error instanceof Error ? context.error.name : undefined,
    metadata: payload
  };
};

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
    if (metadata.schedulerMode !== "aec-batched-decision" && metadata.schedulerMode !== "parallel") return metadata;
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
    resolutionPolicy:
      step.resolutionPolicy ??
      (schedulerMode === "parallel"
        ? "parallel-stepBatch"
        : schedulerMode === "aec-batched-decision"
          ? "sequential-apply-from-shared-decision-state"
          : "sequential-apply")
  };
}

export function createWerewolfJointPhaseSchedulerResolver(
  jointPhaseScheduler: HarnessRunOptions["jointPhaseScheduler"] = DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
): SocialSchedulerResolver<GameState, WerewolfSocialPendingAction> {
  return (context) => {
    if (
      context.pendingActions.length > 0 &&
      context.pendingActions.every((action) => isAgentPendingAction(action) && (action.kind === "vote" || action.kind === "kill"))
    ) {
      return jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER;
    }
    return "aec";
  };
}

export const werewolfLegacySchedulerModeForBatch = createWerewolfJointPhaseSchedulerResolver(
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
);

function createSequentialActorTurnIndexProvider(): SocialActorTurnIndexProvider<GameState, WerewolfSocialPendingAction> {
  let nextTurnIndex = 1;
  return (context) => {
    if (!isAgentPendingAction(context.pendingAction)) return undefined;
    const turnIndex = nextTurnIndex;
    nextTurnIndex += 1;
    return turnIndex;
  };
}

function snapshotAgentStates(actors: readonly Pick<WerewolfSocialActorAdapter, "state">[]): AgentHarnessState[] {
  return actors.map((actor) => cloneJson(actor.state));
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
  },
  actionProposal?: ReasonerOutputSummary["actionProposal"]
): ReasonerOutputSummary {
  return {
    content,
    latencyMs: completion.latencyMs,
    promptTokens: completion.usage?.promptTokens,
    completionTokens: completion.usage?.completionTokens,
    providerRequestId: completion.providerRequestId,
    attempts: completion.attempts,
    retryHistory: cloneJson(completion.retryHistory),
    stream: cloneJson(completion.stream),
    actionProposal: cloneJson(actionProposal)
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Replace the canonical actor snapshot only after an environment commit. */
function replaceAgentHarnessState(target: AgentHarnessState, source: AgentHarnessState): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, cloneJson(source) as unknown as Record<string, unknown>);
}
