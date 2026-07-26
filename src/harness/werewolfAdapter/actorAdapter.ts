import { isAgentPendingAction } from "../../core/pending";
import type { AgentPendingAction } from "../../core/pending";
import type { GameCommand, PlayerView } from "../../core/types";
import {
  WerewolfAgentActor,
  commitWerewolfAgentTurn,
  reduceCommittedWerewolfSocialAction
} from "../actor";
import { hashStableState } from "../hash";
import { attachSpeech } from "../policy";
import type {
  SocialAction,
  SocialActor,
  SocialActorObservationContext,
  SocialActorStepReceipt,
  SocialAgentProfile,
  SocialReasonerCallCollectionContext,
  SocialReasonerCallReport
} from "../social";
import {
  createDeterministicReceiptReflectionPolicy,
  recordCommittedReceiptOutcome,
  recordCommittedReceiptReflection,
  type ScaffoldedSocialActor
} from "../scaffold";
import {
  describeError,
  providerFailureFromError,
  sanitizePersistedProviderDiagnostics
} from "../providerFailure";
import {
  WEREWOLF_HARNESS_TURN_METADATA_KIND,
  parseWerewolfHarnessTurnActionMetadata,
  tryParseWerewolfHarnessTurnActionMetadata
} from "../werewolfExecutionEvidence";
import type {
  AgentHarnessState,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerOutput,
  ReasonerOutputSummary
} from "../types";
import { WEREWOLF_PROFILE_POLICY_SELECTOR_ID } from "./adapterTypes";
import type {
  ReasonerCallTransaction,
  ReasonerCallTransactionContext,
  WerewolfSocialActionMetadata,
  WerewolfSocialActorAdapterOptions,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction
} from "./adapterTypes";
import {
  cloneJson,
  deterministicPolicyMemo,
  deterministicPolicySpeech,
  normalizePolicyOnlyMemoState,
  normalizeSpeech,
  replaceAgentHarnessState,
  requiresWerewolfSpeech,
  summarizePolicyOnlyOutput,
  summarizeReasonerOutput,
  toReasonerAgentContext
} from "./internals";
import { createWerewolfMessageDrafts } from "./messages";
import { createScaffoldedWerewolfActor } from "./scaffoldedActor";

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
  /** Provider evidence is owned by the exact runner transaction that opened
   * it. Closed transactions remain as small tombstones so a provider promise
   * resolving after a decision timeout cannot populate a later turn. */
  private readonly reasonerCallTransactions = new Map<string, ReasonerCallTransaction>();
  private latestReasonerCallContext?: ReasonerCallTransactionContext;
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
      cognitionSource: "reasoner" | "policy";
      pendingAction: AgentPendingAction;
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
      version: "1",
      model: options.actor.state.model,
      temperature: options.actor.state.temperature,
      policyId: WEREWOLF_PROFILE_POLICY_SELECTOR_ID,
      ...(options.reasoner ? { reasonerId: "werewolf-harness-reasoner" } : {})
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
        players: options.players,
        captureReasonerCallContext: () => this.captureReasonerCallContext(),
        onReasonerCompleted: (context, output) => {
          this.recordCompletedReasonerCall(
            context,
            summarizeReasonerOutput(
              output.content,
              output.completion,
              output.actionProposal,
              output.speechActDrafts
            )
          );
        }
      });
    }
  }

  get state(): AgentHarnessState {
    return this.scaffolded ? this.scaffolded.state : this.options.actor.state;
  }

  observe(observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    if (this.scaffolded) {
      if (context?.transactionId && context.traceId) {
        this.openReasonerCallTransaction({ transactionId: context.transactionId, traceId: context.traceId });
      }
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
    if (context?.transactionId && context.traceId) {
      // A failed decision remains bound to the runner's observation trace. A
      // successful legacy tracePrefix action switches this open transaction to
      // its final action trace immediately before decide() returns.
      this.openReasonerCallTransaction({ transactionId, traceId: context.traceId });
    }
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
    // Capture before the first await. A timed-out decision may still settle
    // after the runner has observed a later turn on this actor instance.
    const reasonerCallContext = this.captureReasonerCallContext();
    if (this.scaffolded) {
      try {
        const action = await this.scaffolded.decide(pending);
        this.assertReasonerCallTransactionOpen(reasonerCallContext);
        const metadata = parseWerewolfHarnessTurnActionMetadata(action.metadata, action.traceId ?? `${this.id}:missing-trace`);
        this.turnTraces.set(metadata.turnTrace.traceId, cloneJson(metadata.turnTrace));
        return action;
      } catch (error) {
        this.recordFailedReasonerCall(reasonerCallContext, error);
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

    const latest = this.latest;
    const stagedActor = latest.actor;
    let plan = stagedActor.plan(pending);
    try {
      const reasonerOutput = this.options.reasoner
        ? await this.options.reasoner.think({
            traceId: latest.traceId,
            view: cloneJson(latest.observation.view),
            action: cloneJson(pending),
            agent: toReasonerAgentContext(stagedActor.state),
            policyPlan: cloneJson(plan),
            memoryRetrieval: cloneJson(plan.memoryRetrieval),
            recalledMemory: stagedActor.reasonerMemoryEntries(plan.memoryRetrieval)
          })
        : undefined;
      this.assertReasonerCallTransactionOpen(reasonerCallContext);
      const actionProposal = reasonerOutput?.actionProposal;
      if (reasonerOutput) {
        // Persist the completed provider lifecycle before any domain parsing or
        // candidate validation. A malformed completion is an explicit failed
        // decision with completed-call evidence, never a policy fallback.
        this.recordCompletedReasonerCall(
          reasonerCallContext,
          summarizeReasonerOutput(
            reasonerOutput.content,
            reasonerOutput.completion,
            actionProposal,
            reasonerOutput.speechActDrafts
          )
        );
        plan = stagedActor.applyReasonerProposal(plan, pending, actionProposal);
        if (requiresWerewolfSpeech(pending)) {
          plan = attachSpeech(plan, normalizeSpeech(reasonerOutput.content));
        }
      } else if (requiresWerewolfSpeech(pending)) {
        plan = attachSpeech(plan, deterministicPolicySpeech(pending, plan));
      }
      const privateMemo = reasonerOutput?.content ?? deterministicPolicyMemo(pending, plan);
      const cognitionSource = reasonerOutput ? "reasoner" : "policy";
      const command = stagedActor.act(plan);
      const publicSpeech = command.type === "speech.submit" || command.type === "lastWords.submit" ? command.text : undefined;
      const commitContext = {
        traceId: latest.traceId,
        turnIndex: latest.receiptTurnIndex,
        pendingAction: cloneJson(pending)
      };
      const preview = cloneJson(stagedActor.state);
      commitWerewolfAgentTurn({
        state: preview,
        view: latest.observation.view,
        observeContext: { traceId: latest.traceId, turnIndex: latest.turnIndex },
        plan: cloneJson(plan),
        privateMemo,
        context: commitContext
      });
      if (cognitionSource === "policy") normalizePolicyOnlyMemoState(preview, { cognitionSource, privateMemo });
      const expectedAgentStateHash = preview.socialStateHash;
      if (!expectedAgentStateHash) throw new Error(`Werewolf social actor ${this.id} did not produce an agent state hash.`);
      const trace: HarnessTurnTrace = {
        traceId: latest.traceId,
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
            actionProposal,
            reasonerOutput.speechActDrafts
          )
        : summarizePolicyOnlyOutput(privateMemo);
      const metadata: WerewolfSocialActionMetadata = {
        kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
        turnIndex: latest.turnIndex,
        policyPlan: cloneJson(plan),
        reasonerOutput: cloneJson(reasonerSummary),
        turnTrace: cloneJson(trace),
        agentStateHash: expectedAgentStateHash
      };
      this.turnTraces.set(latest.traceId, trace);
      // Private turn state is transaction-scoped, never action-trace-scoped.
      // In particular, a scheduler-level rejection can deliver a unique
      // runner trace id that differs from the policy-provided trace id.
      this.pendingProposals.set(latest.transactionId, {
        traceId: latest.traceId,
        plan: cloneJson(plan),
        privateMemo,
        cognitionSource,
        pendingAction: cloneJson(pending),
        expectedAgentStateHash
      });
      const action: SocialAction<GameCommand> = {
        actorId: this.id,
        kind: command.type,
        traceId: latest.traceId,
        command,
        metadata: metadata as unknown as Record<string, unknown>,
        messages: createWerewolfMessageDrafts({
          players: this.options.players,
          traceId: latest.traceId,
          turnIndex: latest.turnIndex,
          actorId: this.id,
          pendingAction: pending,
          command,
          policyPlan: plan,
          observation: latest.observation.view,
          reasonerOutput: reasonerSummary
        })
      };
      this.rebindOpenReasonerCallTransaction(reasonerCallContext, action.traceId ?? latest.traceId);
      return action;
    } catch (error) {
      this.recordFailedReasonerCall(reasonerCallContext, error);
      throw new WerewolfSocialTurnError(
        `Harness turn failed for ${this.id}/${this.options.actor.state.model}/${pending.kind}: ${describeError(error)}`,
        error
      );
    }
  }

  takeReasonerCallReports(context: SocialReasonerCallCollectionContext): SocialReasonerCallReport[] {
    const transaction = this.reasonerCallTransactions.get(context.transactionId);
    if (!transaction) {
      this.reasonerCallTransactions.set(context.transactionId, {
        traceId: context.traceId,
        state: "closed",
        reports: []
      });
      if (this.latestReasonerCallContext?.transactionId === context.transactionId) {
        this.latestReasonerCallContext = undefined;
      }
      return [];
    }
    if (transaction.traceId !== context.traceId) {
      throw new Error("Reasoner call report trace does not match its runner transaction.");
    }
    if (transaction.state === "closed") return [];
    const reports = cloneJson(transaction.reports);
    transaction.state = "closed";
    transaction.reports = [];
    if (this.latestReasonerCallContext?.transactionId === context.transactionId) this.latestReasonerCallContext = undefined;
    return reports;
  }

  private openReasonerCallTransaction(context: ReasonerCallTransactionContext): void {
    const existing = this.reasonerCallTransactions.get(context.transactionId);
    if (existing?.state === "closed") {
      throw new Error("Closed reasoner call transaction cannot be reopened.");
    }
    if (existing && existing.traceId !== context.traceId) {
      throw new Error("Reasoner call transaction cannot change trace identity.");
    }
    if (!existing) {
      this.reasonerCallTransactions.set(context.transactionId, {
        traceId: context.traceId,
        state: "open",
        reports: []
      });
    }
    this.latestReasonerCallContext = cloneJson(context);
  }

  private captureReasonerCallContext(): ReasonerCallTransactionContext | undefined {
    const context = this.latestReasonerCallContext;
    if (!context) return undefined;
    const transaction = this.reasonerCallTransactions.get(context.transactionId);
    if (!transaction || transaction.state !== "open" || transaction.traceId !== context.traceId) return undefined;
    return cloneJson(context);
  }

  private assertReasonerCallTransactionOpen(context: ReasonerCallTransactionContext | undefined): void {
    if (!context) return;
    const transaction = this.reasonerCallTransactions.get(context.transactionId);
    if (!transaction || transaction.state !== "open" || transaction.traceId !== context.traceId) {
      throw new Error("Reasoner decision completed after its runner transaction closed.");
    }
  }

  private rebindOpenReasonerCallTransaction(
    context: ReasonerCallTransactionContext | undefined,
    traceId: string
  ): void {
    if (!context || context.traceId === traceId) return;
    const transaction = this.reasonerCallTransactions.get(context.transactionId);
    if (!transaction || transaction.state !== "open" || transaction.traceId !== context.traceId) {
      throw new Error("Reasoner call transaction closed before final action trace binding.");
    }
    transaction.traceId = traceId;
    context.traceId = traceId;
    if (this.latestReasonerCallContext?.transactionId === context.transactionId) {
      this.latestReasonerCallContext.traceId = traceId;
    }
  }

  private recordCompletedReasonerCall(
    context: ReasonerCallTransactionContext | undefined,
    summary: ReasonerOutputSummary
  ): void {
    if (summary.cognitionSource === "policy" || !summary.stream) return;
    const report: SocialReasonerCallReport = {
      outcome: "completed",
      latencyMs: summary.latencyMs,
      attempts: summary.attempts ?? 1,
      usage: {
        ...(summary.promptTokens === undefined ? {} : { promptTokens: summary.promptTokens }),
        ...(summary.completionTokens === undefined ? {} : { completionTokens: summary.completionTokens }),
        ...(summary.totalTokens === undefined ? {} : { totalTokens: summary.totalTokens })
      },
      retryHistory: cloneJson(summary.retryHistory),
      stream: cloneJson(summary.stream)
    };
    this.writeReasonerCallReports(context, [sanitizePersistedProviderDiagnostics(report)]);
  }

  private recordFailedReasonerCall(context: ReasonerCallTransactionContext | undefined, error: unknown): void {
    const failure = providerFailureFromError(error);
    if (!failure) return;
    this.writeReasonerCallReports(context, [{
      outcome: failure.failureKind === "abort" || failure.aborted === true ? "aborted" : "failed",
      attempts: failure.attempts,
      stream: { enabled: true, completed: false },
      failure: cloneJson(failure)
    }]);
  }

  private writeReasonerCallReports(
    context: ReasonerCallTransactionContext | undefined,
    reports: SocialReasonerCallReport[]
  ): void {
    if (!context) return;
    const transaction = this.reasonerCallTransactions.get(context.transactionId);
    if (!transaction || transaction.state !== "open" || transaction.traceId !== context.traceId) return;
    transaction.reports = cloneJson(reports);
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
      pendingAction: proposal.pendingAction
    });
    normalizePolicyOnlyMemoState(stagedActor.state, {
      cognitionSource: proposal.cognitionSource,
      privateMemo: proposal.privateMemo
    });
    const agentStateHash = stagedActor.state.socialStateHash;
    if (agentStateHash !== proposal.expectedAgentStateHash) {
      throw new Error(
        `Committed agent state hash mismatch for ${this.id}: expected ${proposal.expectedAgentStateHash}, received ${agentStateHash}.`
      );
    }
    // Keep the legacy compatibility actor aligned with the production
    // scaffold: only after validating the planned pre-receipt state do we
    // append the generic, closed environment-outcome memory and publish the
    // final durable actor snapshot.
    if (!stagedActor.state.social) throw new Error(`Werewolf social actor ${this.id} is missing social state after commit.`);
    recordCommittedReceiptOutcome(stagedActor.state.social, receipt);
    reduceCommittedWerewolfSocialAction(stagedActor.state.social, receipt);
    recordCommittedReceiptReflection({
      agentId: this.id,
      state: stagedActor.state,
      social: stagedActor.state.social,
      receipt,
      policy: createDeterministicReceiptReflectionPolicy<
        PlayerView,
        WerewolfSocialPendingAction,
        GameCommand,
        AgentHarnessState
      >(),
      cloneState: cloneJson
    });
    stagedActor.state.socialStateHash = hashStableState(stagedActor.state.social);
    replaceAgentHarnessState(this.options.actor.state, stagedActor.state);
  }

  turnTraceFor(traceId: string | undefined): HarnessTurnTrace | undefined {
    if (!traceId) return undefined;
    return cloneJson(this.turnTraces.get(traceId));
  }
}
