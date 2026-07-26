import { isAgentPendingAction } from "../../core/pending";
import type { AgentPendingAction } from "../../core/pending";
import type { GameCommand, PlayerState } from "../../core/types";
import {
  WerewolfAgentActor,
  applyWerewolfReasonerProposal,
  commitWerewolfAgentTurn,
  reduceCommittedWerewolfSocialAction,
  type WerewolfAgentObserveContext
} from "../actor";
import { hashStableState } from "../hash";
import { attachSpeech, planAction } from "../policy";
import type {
  SocialAction,
  SocialActorObservationContext,
  SocialAgentProfile
} from "../social";
import {
  createScaffoldedActor,
  createDeterministicReceiptReflectionPolicy,
  type AgentActionCandidate,
  type AgentActionArbitrationSummary,
  type AgentDecisionInput,
  type AgentPolicy,
  type AgentReasoner,
  type ScaffoldCanonicalStateAdapter,
  type ScaffoldedSocialActor
} from "../scaffold";
import {
  WEREWOLF_HARNESS_TURN_METADATA_KIND,
  parseWerewolfHarnessTurnActionMetadata
} from "../werewolfExecutionEvidence";
import type {
  AgentHarnessState,
  HarnessPlayerView,
  HarnessReasoner,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerMemoryEntry,
  ReasonerOutput
} from "../types";
import type {
  ReasonerCallTransactionContext,
  WerewolfSocialActionMetadata,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction
} from "./adapterTypes";
import {
  cloneJson,
  deterministicPolicyMemo,
  deterministicPolicySpeech,
  normalizePolicyOnlyMemoState,
  normalizeSpeech,
  requiresWerewolfSpeech,
  summarizePolicyOnlyOutput,
  summarizeReasonerOutput,
  toReasonerAgentContext
} from "./internals";
import { createWerewolfMessageDrafts } from "./messages";

/**
 * Production bridge: `AgentHarnessState` is the only durable private state.
 * The generic scaffold owns speculative cloning, candidate sequencing, and
 * receipt-gated replacement; these domain callbacks only reduce/commit that
 * one canonical state and project existing Werewolf evidence envelopes.
 */
export function createScaffoldedWerewolfActor(input: {
  id: string;
  profile: SocialAgentProfile;
  initialState: AgentHarnessState;
  reasoner?: HarnessReasoner;
  players: PlayerState[];
  captureReasonerCallContext?: () => ReasonerCallTransactionContext | undefined;
  onReasonerCompleted?: (context: ReasonerCallTransactionContext | undefined, output: ReasonerOutput) => void;
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
      return state.social as unknown as import("../socialState").AgentSocialState<
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
      validateSelectedWerewolfArbitration(metadata.actionArbitration, action);
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
          pendingAction: cloneJson(playerTurn.pending)
        }
      });
      normalizePolicyOnlyMemoState(state, metadata.turnTrace);
      if (state.socialStateHash !== metadata.agentStateHash) {
        throw new Error(
          `Scaffolded Werewolf committed agent state hash mismatch for ${state.playerId}: expected ${metadata.agentStateHash}, received ${state.socialStateHash}.`
        );
      }
    },
    // The generic scaffold writes receipt-gated environment outcome memory
    // immediately before this hook. The domain state owns the compatibility
    // hash, so refresh it after that committed private-state reduction.
    afterStepResult: ({ state, receipt }) => {
      if (!state.social) throw new Error(`Scaffolded Werewolf actor ${state.playerId} is missing social state after receipt.`);
      reduceCommittedWerewolfSocialAction(state.social, receipt);
      state.socialStateHash = hashStableState(state.social);
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
    decide: (decision) => buildScaffoldedWerewolfAction({ decision, players: input.players }),
    generateCandidates: (decision) => generateScaffoldedWerewolfCandidates({ decision, players: input.players })
  };
  const harnessReasoner = input.reasoner;
  const reasoner: AgentReasoner<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  > | undefined = harnessReasoner
    ? {
        id: "werewolf-harness-reasoner",
        async reflect(decision) {
          // Capture before awaiting the provider. A timed-out completion may
          // settle after a later turn has opened, but its telemetry must stay
          // bound to the original runner transaction.
          const reasonerCallContext = input.captureReasonerCallContext?.();
          const playerTurn = requireScaffoldedWerewolfPlayerTurn({
            observation: decision.observation,
            pending: decision.pendingAction,
            context: decision.observationContext
          });
          const policyPlan = werewolfPolicyPlanForScaffoldDecision(decision, playerTurn);
          const output = await harnessReasoner.think({
            traceId: playerTurn.traceId,
            view: cloneJson(playerTurn.view),
            action: cloneJson(playerTurn.pending),
            agent: toReasonerAgentContext(decision.agent),
            policyPlan: cloneJson(policyPlan),
            memoryRetrieval: cloneJson(decision.memoryRetrieval),
            recalledMemory: scaffoldReasonerMemoryEntries(decision)
          });
          input.onReasonerCompleted?.(reasonerCallContext, cloneJson(output));
          return {
            memo: output.content,
            advice: cloneJson(output)
          };
        }
      }
    : undefined;
  return createScaffoldedActor({
    id: input.id,
    profile: input.profile,
    policy,
    reasoner,
    receiptReflectionPolicy: createDeterministicReceiptReflectionPolicy<
      WerewolfSocialObservation,
      WerewolfSocialPendingAction,
      GameCommand,
      AgentHarnessState
    >(),
    initialCanonicalState: cloneJson(input.initialState),
    canonicalStateAdapter: stateAdapter
  });
}

function generateScaffoldedWerewolfCandidates(input: {
  decision: AgentDecisionInput<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >;
  players: PlayerState[];
}): Array<AgentActionCandidate<GameCommand>> {
  const playerTurn = requireScaffoldedWerewolfPlayerTurn({
    observation: input.decision.observation,
    pending: input.decision.pendingAction,
    context: input.decision.observationContext
  });
  let policyPlan = werewolfPolicyPlanForScaffoldDecision(input.decision, playerTurn);
  const reasonerOutput = input.decision.reasoner?.advice;
  if (requiresWerewolfSpeech(playerTurn.pending)) {
    policyPlan = attachSpeech(policyPlan, deterministicPolicySpeech(playerTurn.pending, policyPlan));
  }
  const policyAction = buildScaffoldedWerewolfActionForPlan({
    decision: input.decision,
    players: input.players,
    playerTurn,
    plan: policyPlan,
    selectedSource: "policy"
  });
  const candidates: Array<AgentActionCandidate<GameCommand>> = [
    werewolfActionCandidate({
      playerTurn,
      plan: policyPlan,
      action: policyAction,
      source: "policy"
    })
  ];
  if (!reasonerOutput) return candidates;

  let reasonerPlan = applyWerewolfReasonerProposal(
    werewolfPolicyPlanForScaffoldDecision(input.decision, playerTurn),
    playerTurn.pending,
    reasonerOutput.actionProposal
  );
  if (requiresWerewolfSpeech(playerTurn.pending)) {
    reasonerPlan = attachSpeech(reasonerPlan, normalizeSpeech(reasonerOutput.content));
  }
  const reasonerAction = buildScaffoldedWerewolfActionForPlan({
    decision: input.decision,
    players: input.players,
    playerTurn,
    plan: reasonerPlan,
    selectedSource: "reasoner"
  });
  if (
    hashStableState({ command: reasonerAction.command, messages: reasonerAction.messages ?? [] }) ===
    hashStableState({ command: policyAction.command, messages: policyAction.messages ?? [] })
  ) {
    return candidates;
  }
  candidates.push(
    werewolfActionCandidate({
      playerTurn,
      plan: reasonerPlan,
      action: reasonerAction,
      source: "reasoner",
      // On communicative turns the validated reasoner-authored language is the
      // primary candidate. The deterministic policy candidate remains an
      // explicitly named arbitration alternative, not a provider fallback.
      scoreAdjustment: requiresWerewolfSpeech(playerTurn.pending) ? 0.001 : 0
    })
  );
  return candidates;
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
  const candidates = generateScaffoldedWerewolfCandidates(input);
  return cloneJson(candidates[0].action);
}

function buildScaffoldedWerewolfActionForPlan(input: {
  decision: AgentDecisionInput<
    WerewolfSocialObservation,
    WerewolfSocialPendingAction,
    GameCommand,
    AgentHarnessState,
    ReasonerOutput
  >;
  players: PlayerState[];
  playerTurn: ReturnType<typeof requireScaffoldedWerewolfPlayerTurn>;
  plan: PolicyPlan;
  selectedSource: "policy" | "reasoner";
}): SocialAction<GameCommand> {
  const { playerTurn, plan } = input;
  const reasonerOutput = input.decision.reasoner?.advice;
  const privateMemo = reasonerOutput?.content ?? deterministicPolicyMemo(playerTurn.pending, plan);
  const cognitionSource = reasonerOutput ? "reasoner" : "policy";
  const command = plan.command;
  const commitContext = {
    traceId: playerTurn.traceId,
    turnIndex: playerTurn.receiptTurnIndex,
    pendingAction: cloneJson(playerTurn.pending)
  };
  const preview = cloneJson(input.decision.agent);
  commitWerewolfAgentTurn({
    state: preview,
    view: playerTurn.view,
    observeContext: playerTurn.observeContext,
    plan: cloneJson(plan),
    privateMemo,
    context: commitContext
  });
  if (cognitionSource === "policy") normalizePolicyOnlyMemoState(preview, { cognitionSource, privateMemo });
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
    privateMemo,
    cognitionSource,
    publicSpeech,
    latencyMs: reasonerOutput?.completion.latencyMs ?? 0,
    promptTokens: reasonerOutput?.completion.usage.promptTokens,
    completionTokens: reasonerOutput?.completion.usage.completionTokens,
    totalTokens: reasonerOutput?.completion.usage.totalTokens,
    attempts: reasonerOutput?.completion.attempts,
    retryHistory: cloneJson(reasonerOutput?.completion.retryHistory),
    stream: cloneJson(reasonerOutput?.completion.stream),
    agentStateHash: expectedAgentStateHash
  };
  const reasonerSummary = reasonerOutput
    ? summarizeReasonerOutput(
        reasonerOutput.content,
        reasonerOutput.completion,
        reasonerOutput.actionProposal,
        reasonerOutput.speechActDrafts
      )
    : summarizePolicyOnlyOutput(privateMemo);
  const selectedReasonerSummary = input.selectedSource === "reasoner"
    ? reasonerSummary
    : { ...reasonerSummary, speechActDrafts: undefined };
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
      reasonerOutput: selectedReasonerSummary
    })
  };
}

function werewolfActionCandidate(input: {
  playerTurn: ReturnType<typeof requireScaffoldedWerewolfPlayerTurn>;
  plan: PolicyPlan;
  action: SocialAction<GameCommand>;
  source: "policy" | "reasoner";
  scoreAdjustment?: number;
}): AgentActionCandidate<GameCommand> {
  const score = Math.max(0, Math.min(1.001, input.plan.confidence + (input.scoreAdjustment ?? 0)));
  const command = input.plan.command;
  const targetIds = Array.from(new Set([
    input.plan.targetId,
    input.plan.pressureTargetId,
    "targetId" in command ? command.targetId : undefined,
    command.type === "witch.act" ? command.saveTargetId : undefined,
    command.type === "witch.act" ? command.poisonTargetId : undefined
  ].filter((value): value is string => Boolean(value))));
  return {
    id: `werewolf:${input.action.actorId}:${input.playerTurn.pending.kind}:${input.source}:${werewolfCandidateVariant(input.plan)}`,
    actorId: input.action.actorId,
    kind: input.action.kind,
    source: input.source,
    socialTargetIds: targetIds.length ? targetIds : undefined,
    action: cloneJson(input.action),
    baseScore: input.plan.confidence,
    utilityScore: input.plan.confidence,
    legalityScore: 1,
    finalScore: score,
    reasons: [
      input.source === "policy"
        ? "domain policy produced a complete legal-intent candidate"
        : "domain legality boundary accepted a distinct reasoner candidate"
    ],
    evidenceRefs: [
      {
        artifact: "observation",
        traceId: input.playerTurn.traceId,
        description: `scoped ${input.playerTurn.pending.kind} observation`
      },
      {
        artifact: "trace",
        traceId: input.playerTurn.traceId,
        description: `${input.source} candidate generation`
      }
    ]
  };
}

function werewolfCandidateVariant(plan: PolicyPlan): string {
  const command = plan.command;
  if ("targetId" in command && typeof command.targetId === "string") return `target-${command.targetId}`;
  if (command.type === "witch.act") return `save-${command.saveTargetId ?? "none"}-poison-${command.poisonTargetId ?? "none"}`;
  if ((command.type === "vote.cast" || command.type === "sheriff.vote") && command.abstain) return "abstain";
  if (command.type === "speech.submit" || command.type === "lastWords.submit") return "speech";
  return "default";
}

function validateSelectedWerewolfArbitration(
  arbitration: AgentActionArbitrationSummary | undefined,
  action: SocialAction<GameCommand>
): void {
  if (!arbitration) throw new Error(`Scaffolded Werewolf action ${action.traceId ?? action.kind} is missing candidate arbitration.`);
  if (arbitration.version !== "agent.action-arbitration.v1" || arbitration.actorId !== action.actorId) {
    throw new Error(`Scaffolded Werewolf action ${action.traceId ?? action.kind} has invalid candidate arbitration authority.`);
  }
  if (arbitration.candidateCount !== arbitration.candidates.length || arbitration.candidateCount < 1) {
    throw new Error(`Scaffolded Werewolf action ${action.traceId ?? action.kind} has an inconsistent candidate count.`);
  }
  const selected = arbitration.candidates.find((candidate) => candidate.id === arbitration.selectedCandidateId);
  if (!selected || selected.actorId !== action.actorId || selected.kind !== action.kind) {
    throw new Error(`Scaffolded Werewolf action ${action.traceId ?? action.kind} does not match its selected candidate.`);
  }
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
