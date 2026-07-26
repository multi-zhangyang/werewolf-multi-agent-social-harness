import type {
  SocialAction,
  SocialActor,
  SocialActorObservationContext,
  SocialActorStepReceipt,
  SocialAgentProfile
} from "../social";
import {
  extractVisibleSocialMessagesFromObservation,
  hydrateSeenSocialMessageIds,
  ingestVisibleSocialMessages
} from "../socialObservationIngestor";
import {
  appendSocialMemory,
  createAgentSocialState,
  retrieveMemoryContext,
  type AgentSocialState,
  type MemoryRetrievalRecord,
  type SocialMemoryEntry,
  type SocialStateMutationContext
} from "../socialState";
import {
  applyScoreContribution,
  buildArbitrationSummary,
  candidateFromPolicyAction,
  defaultActionArbitrationDecision,
  normalizeAgentReasonerOutput,
  normalizeCandidates,
  normalizeScoreContribution,
  withArbitrationMetadata
} from "./candidates";
import { cloneJson } from "./internals";
import {
  receiptMutationContext,
  recordCommittedReceiptOutcome,
  recordCommittedReceiptReflection,
  scaffoldMutationContext
} from "./receipts";
import type {
  AgentActionArbitrationSummary,
  AgentActionArbitrator,
  AgentActionCandidate,
  AgentActionCandidateScorer,
  AgentDecisionInput,
  AgentPolicy,
  AgentReasoner,
  AgentScaffoldState,
  ReceiptReflectionPolicy,
  ScaffoldCanonicalStateAdapter,
  ScaffoldMemoryEntry,
  ScaffoldedActorOptions,
  StagedScaffoldTurn
} from "./types";

export class ScaffoldedSocialActor<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
>
  implements SocialActor<TObservation, TPending, TCommand>
{
  readonly id: string;
  readonly profile: SocialAgentProfile;
  readonly policy: AgentPolicy<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  readonly reasoner?: AgentReasoner<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  readonly candidateScorers: Array<AgentActionCandidateScorer<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>>;
  readonly actionArbitrator?: AgentActionArbitrator<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  readonly receiptReflectionPolicy?: ReceiptReflectionPolicy<TObservation, TPending, TCommand, TAgentState>;
  readonly maxMemoryEntries: number;
  private readonly canonicalStateAdapter?: ScaffoldCanonicalStateAdapter<TAgentState, TObservation, TPending, TCommand, TReasonerAdvice>;
  private mutableState: TAgentState;
  private latestObservationContext?: SocialActorObservationContext<TPending>;
  private latestObservation?: TObservation;
  private readonly seenMessageIds = new Set<string>();
  private readonly stagedTurns = new Map<string, StagedScaffoldTurn<TAgentState, TObservation, TPending>>();
  private latestStagedTraceId?: string;
  private activeStagedTurn?: StagedScaffoldTurn<TAgentState, TObservation, TPending>;

  constructor(options: ScaffoldedActorOptions<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>) {
    this.id = options.id;
    this.profile = cloneJson(options.profile);
    this.policy = options.policy;
    this.reasoner = options.reasoner;
    this.candidateScorers = [...(options.candidateScorers ?? [])];
    this.actionArbitrator = options.actionArbitrator;
    this.receiptReflectionPolicy = options.receiptReflectionPolicy;
    this.maxMemoryEntries = options.maxMemoryEntries ?? 200;
    this.canonicalStateAdapter = options.canonicalStateAdapter;
    if (this.canonicalStateAdapter) {
      if (options.initialCanonicalState === undefined) {
        throw new Error(`Scaffolded actor ${options.id} requires initialCanonicalState with canonicalStateAdapter.`);
      }
      if (options.initialSocialState) {
        throw new Error(`Scaffolded actor ${options.id} cannot combine initialSocialState with canonicalStateAdapter.`);
      }
      this.mutableState = this.canonicalStateAdapter.clone(options.initialCanonicalState);
      return;
    }
    if (options.initialCanonicalState !== undefined) {
      throw new Error(`Scaffolded actor ${options.id} requires canonicalStateAdapter for initialCanonicalState.`);
    }
    if (options.initialSocialState && options.initialSocialState.agentId !== options.id) {
      throw new Error(`Initial social state belongs to ${options.initialSocialState.agentId}, expected ${options.id}.`);
    }
    this.mutableState = {
      id: options.id,
      profile: cloneJson(options.profile),
      observations: 0,
      decisions: 0,
      memory: [],
      social: options.initialSocialState
        ? cloneJson(options.initialSocialState)
        : createAgentSocialState({
            agentId: options.id,
            profile: options.profile,
            maxMemoryEntries: this.maxMemoryEntries
          })
    } as TAgentState;
    hydrateSeenSocialMessageIds(this.defaultState().social, this.seenMessageIds);
  }

  get state(): TAgentState {
    return this.cloneState(this.mutableState);
  }

  observe(observation: TObservation, context?: SocialActorObservationContext<TPending>): void {
    const stagedTurn = context?.transactional === true && context.traceId ? this.createStagedTurn(context) : undefined;
    if (!stagedTurn) this.latestObservationContext = cloneJson(context);
    this.withActiveStagedTurn(stagedTurn, () => {
      const observed = cloneJson(observation);
      if (stagedTurn) stagedTurn.observation = cloneJson(observed);
      else this.latestObservation = cloneJson(observed);
      if (this.canonicalStateAdapter) {
        this.canonicalStateAdapter.observe({
          state: this.workingState(),
          observation: observed,
          context: cloneJson(this.workingObservationContext())
        });
        return;
      }
      const state = this.defaultState();
      state.observations += 1;
      state.lastObservation = observed;
      this.remember({
        kind: "observation",
        observation: cloneJson(observed),
        source: "observation",
        visibility: "private",
        evidenceRefs: [{ artifact: "observation", seq: state.observations }]
      }, scaffoldMutationContext(this.workingObservationContext()));
      const visibleMessages = extractVisibleSocialMessagesFromObservation(observed);
      if (visibleMessages.length) {
        ingestVisibleSocialMessages({
          social: state.social,
          observerId: this.id,
          messages: visibleMessages,
          seenMessageIds: this.workingSeenMessageIds(),
          context: scaffoldMutationContext(this.workingObservationContext())
        });
        this.syncCompatibilityMemory();
      }
    });
  }

  async decide(pending: TPending): Promise<SocialAction<TCommand>> {
    const stagedTurn = this.latestStagedTraceId ? this.stagedTurns.get(this.latestStagedTraceId) : undefined;
    return this.withActiveStagedTurnAsync(stagedTurn, async () => {
      const state = this.workingState();
      const observation = this.workingObservation();
      if (observation === undefined) {
        throw new Error(`Scaffolded actor ${this.id} cannot decide before observe().`);
      }
      const recall = retrieveMemoryContext(this.workingSocialState().memory, {
        actorId: this.id,
        traceId: this.workingObservationContext()?.traceId,
        limit: 6
      });
      const input = this.decisionInput(observation, pending, recall.evidence, recall.entries);
      const reasonerOutput = normalizeAgentReasonerOutput(await this.reasoner?.reflect(cloneJson(input)));
      const memo = reasonerOutput?.memo;
      const decisionInput = reasonerOutput
        ? {
            ...input,
            reasoner: cloneJson(reasonerOutput)
          }
        : input;
      if (memo && !this.canonicalStateAdapter) {
        this.remember({
          kind: "memo",
          pendingAction: cloneJson(pending),
          content: memo,
          source: "reasoner",
          visibility: "private",
          evidenceRefs: [{ artifact: "memory", description: `reasoner:${this.reasoner?.id}` }],
          tags: ["reasoner-memo"],
          metadata: {
            reasonerId: this.reasoner?.id
          }
        }, scaffoldMutationContext(this.workingObservationContext()));
      }
      const { action, arbitration } = await this.selectAction(decisionInput, memo);
      if (action.actorId !== this.id) {
        throw new Error(`Policy ${this.policy.id} returned action for ${action.actorId}, expected ${this.id}.`);
      }
      const actionWithArbitration = arbitration ? withArbitrationMetadata(action, arbitration) : action;
      if (this.canonicalStateAdapter) {
        this.canonicalStateAdapter.afterDecision({
          state,
          observation: cloneJson(observation),
          pendingAction: cloneJson(pending),
          action: cloneJson(actionWithArbitration),
          decisionInput: cloneJson(decisionInput),
          reasonerOutput: cloneJson(reasonerOutput),
          arbitration: cloneJson(arbitration),
          context: cloneJson(this.workingObservationContext())
        });
      } else {
        const defaultState = this.defaultState();
        defaultState.decisions += 1;
        defaultState.lastAction = cloneJson(actionWithArbitration);
        this.remember({
          kind: "decision",
          pendingAction: cloneJson(pending),
          action: cloneJson(actionWithArbitration),
          source: "policy",
          visibility: "private",
          evidenceRefs: [{ artifact: "action", description: `policy:${this.policy.id}` }],
          tags: arbitration ? ["policy-decision", "action-arbitration"] : ["policy-decision"],
          metadata: arbitration
            ? {
                policyId: this.policy.id,
                arbitration,
                memoryRetrieval: cloneJson(decisionInput.memoryRetrieval)
              }
            : {
                policyId: this.policy.id,
                memoryRetrieval: cloneJson(decisionInput.memoryRetrieval)
              }
        }, scaffoldMutationContext(this.workingObservationContext()));
      }
      return cloneJson(actionWithArbitration);
    });
  }

  onStepResult(receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>): void {
    const transactionId = receipt.transactionId ?? receipt.traceId;
    const stagedTurn = this.stagedTurns.get(transactionId);
    if (!stagedTurn) return;
    this.stagedTurns.delete(transactionId);
    if (this.latestStagedTraceId === transactionId) this.latestStagedTraceId = undefined;
    if (receipt.status !== "committed") return;

    const committedState = this.cloneState(stagedTurn.state);
    recordCommittedReceiptOutcome(
      this.socialStateForState(committedState),
      receipt,
      receiptMutationContext(receipt)
    );
    let receiptReflectionFailure: Error | undefined;
    if (this.receiptReflectionPolicy) {
      try {
        recordCommittedReceiptReflection({
          agentId: this.id,
          state: committedState,
          social: this.socialStateForState(committedState),
          receipt,
          policy: this.receiptReflectionPolicy,
          cloneState: (state) => this.cloneState(state)
        });
      } catch (error) {
        receiptReflectionFailure = error instanceof Error
          ? error
          : new Error(`Receipt reflection policy ${this.receiptReflectionPolicy.id} failed at the safe policy boundary.`);
      }
    }
    this.canonicalStateAdapter?.afterStepResult?.({
      state: committedState,
      receipt: cloneJson(receipt)
    });
    this.mutableState = committedState;
    this.latestObservation = cloneJson(stagedTurn.observation);
    if (!this.canonicalStateAdapter) {
      this.seenMessageIds.clear();
      for (const messageId of stagedTurn.seenMessageIds) this.seenMessageIds.add(messageId);
      this.syncCompatibilityMemory();
    }
    // The environment transition is already authoritative. A faulty optional
    // reflection policy may fail the episode, but it must not roll durable
    // outcome feedback or the domain finalizer back to the pre-step snapshot.
    if (receiptReflectionFailure) throw receiptReflectionFailure;
  }

  private async selectAction(
    input: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>,
    reasonerMemo?: string
  ): Promise<{ action: SocialAction<TCommand>; arbitration?: AgentActionArbitrationSummary }> {
    const generated = this.policy.generateCandidates?.(cloneJson(input));
    if (!generated && !this.actionArbitrator && !this.candidateScorers.length) {
      return { action: this.policy.decide(cloneJson(input)) };
    }
    const candidates = generated ?? [candidateFromPolicyAction(this.id, this.policy.id, this.policy.decide(cloneJson(input)))];
    const normalized = await this.scoreCandidates(normalizeCandidates(this.id, candidates), input, reasonerMemo);
    const decision = this.actionArbitrator
      ? await this.actionArbitrator.arbitrate({
          ...cloneJson(input),
          policyId: this.policy.id,
          reasonerMemo,
          reasonerAdvice: cloneJson(input.reasoner?.advice),
          candidates: cloneJson(normalized)
        })
      : defaultActionArbitrationDecision(normalized);
    const selected = normalized.find((candidate) => candidate.id === decision.selectedCandidateId);
    if (!selected) {
      throw new Error(`Action arbitrator ${this.actionArbitrator?.id ?? "default"} selected unknown candidate ${decision.selectedCandidateId}.`);
    }
    const arbitration = buildArbitrationSummary({
      actorId: this.id,
      policyId: this.policy.id,
      arbitratorId: this.actionArbitrator?.id ?? "default-score-arbitrator",
      decision,
      candidates: normalized
    });
    return {
      action: cloneJson(selected.action),
      arbitration
    };
  }

  private async scoreCandidates(
    candidates: Array<AgentActionCandidate<TCommand>>,
    input: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>,
    reasonerMemo?: string
  ): Promise<Array<AgentActionCandidate<TCommand>>> {
    if (!this.candidateScorers.length) return candidates;
    const scored: Array<AgentActionCandidate<TCommand>> = [];
    for (const candidate of candidates) {
      let next = cloneJson(candidate);
      for (const scorer of this.candidateScorers) {
        const contribution = await scorer.score({
          ...cloneJson(input),
          policyId: this.policy.id,
          reasonerMemo,
          reasonerAdvice: cloneJson(input.reasoner?.advice),
          candidate: cloneJson(next),
          candidates: cloneJson(candidates)
        });
        if (!contribution) continue;
        next = applyScoreContribution(next, normalizeScoreContribution(scorer.id, contribution));
      }
      scored.push(next);
    }
    return scored;
  }

  private decisionInput(
    observation: TObservation,
    pending: TPending,
    memoryRetrieval?: MemoryRetrievalRecord,
    recalledMemory?: Array<SocialMemoryEntry<TObservation, TPending, TCommand>>
  ): AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice> {
    return {
      agent: this.cloneState(this.workingState()),
      social: cloneJson(this.workingSocialState()),
      observation: cloneJson(observation),
      pendingAction: cloneJson(pending),
      observationContext: cloneJson(this.workingObservationContext()),
      memoryRetrieval: cloneJson(memoryRetrieval),
      recalledMemory: cloneJson(recalledMemory)
    };
  }

  private remember(
    entry: Omit<ScaffoldMemoryEntry<TObservation, TPending, TCommand>, "seq" | "createdAt">,
    context?: SocialStateMutationContext
  ): void {
    appendSocialMemory(this.defaultState().social, {
      kind: entry.kind,
      source: entry.source,
      visibility: entry.visibility,
      observation: cloneJson(entry.observation),
      pendingAction: cloneJson(entry.pendingAction),
      action: cloneJson(entry.action),
      content: entry.content,
      salience: entry.salience,
      importance: entry.importance,
      evidenceRefs: entry.evidenceRefs,
      tags: entry.tags,
      metadata: entry.metadata
    }, context);
    this.syncCompatibilityMemory();
  }

  private syncCompatibilityMemory(): void {
    const state = this.defaultState();
    state.memory = state.social.memory.entries.map((memoryEntry) => ({
      seq: memoryEntry.seq,
      kind:
        memoryEntry.kind === "observation" ||
        memoryEntry.kind === "decision" ||
        memoryEntry.kind === "memo" ||
        memoryEntry.kind === "outcome"
          ? memoryEntry.kind
          : "memo",
      observation: cloneJson(memoryEntry.observation),
      pendingAction: cloneJson(memoryEntry.pendingAction),
      action: cloneJson(memoryEntry.action),
      content: memoryEntry.content,
      createdAt: memoryEntry.createdAt,
      source: memoryEntry.source,
      visibility: memoryEntry.visibility,
      evidenceRefs: cloneJson(memoryEntry.evidenceRefs),
      tags: [...memoryEntry.tags],
      salience: memoryEntry.salience,
      importance: memoryEntry.importance,
      metadata: cloneJson(memoryEntry.metadata)
    }));
  }

  private createStagedTurn(
    context: SocialActorObservationContext<TPending>
  ): StagedScaffoldTurn<TAgentState, TObservation, TPending> {
    const traceId = context.traceId;
    if (!traceId) throw new Error(`Scaffolded actor ${this.id} requires traceId for a staged turn.`);
    const transactionId = context.transactionId ?? traceId;
    const stagedTurn: StagedScaffoldTurn<TAgentState, TObservation, TPending> = {
      traceId,
      state: this.cloneState(this.mutableState),
      seenMessageIds: new Set(this.seenMessageIds),
      observationContext: cloneJson(context)
    };
    this.stagedTurns.set(transactionId, stagedTurn);
    this.latestStagedTraceId = transactionId;
    return stagedTurn;
  }

  private workingState(): TAgentState {
    return this.activeStagedTurn?.state ?? this.mutableState;
  }

  private defaultState(): AgentScaffoldState<TObservation, TPending, TCommand> {
    if (this.canonicalStateAdapter) {
      throw new Error(`Scaffolded actor ${this.id} uses canonicalStateAdapter and has no default scaffold state.`);
    }
    return this.workingState() as unknown as AgentScaffoldState<TObservation, TPending, TCommand>;
  }

  private cloneState(state: TAgentState): TAgentState {
    return this.canonicalStateAdapter ? this.canonicalStateAdapter.clone(state) : cloneJson(state);
  }

  private workingSocialState(): AgentSocialState<TObservation, TPending, TCommand> {
    return this.socialStateForState(this.workingState());
  }

  private socialStateForState(state: TAgentState): AgentSocialState<TObservation, TPending, TCommand> {
    return this.canonicalStateAdapter
      ? this.canonicalStateAdapter.socialState(state)
      : (state as unknown as AgentScaffoldState<TObservation, TPending, TCommand>).social;
  }

  private workingObservation(): TObservation | undefined {
    return this.activeStagedTurn?.observation ?? this.latestObservation ?? (this.canonicalStateAdapter ? undefined : this.defaultState().lastObservation);
  }

  private workingSeenMessageIds(): Set<string> {
    return this.activeStagedTurn?.seenMessageIds ?? this.seenMessageIds;
  }

  private workingObservationContext(): SocialActorObservationContext<TPending> | undefined {
    return this.activeStagedTurn?.observationContext ?? this.latestObservationContext;
  }

  private withActiveStagedTurn<TResult>(
    stagedTurn: StagedScaffoldTurn<TAgentState, TObservation, TPending> | undefined,
    operation: () => TResult
  ): TResult {
    const previous = this.activeStagedTurn;
    this.activeStagedTurn = stagedTurn;
    try {
      return operation();
    } finally {
      this.activeStagedTurn = previous;
    }
  }

  private async withActiveStagedTurnAsync<TResult>(
    stagedTurn: StagedScaffoldTurn<TAgentState, TObservation, TPending> | undefined,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    const previous = this.activeStagedTurn;
    this.activeStagedTurn = stagedTurn;
    try {
      return await operation();
    } finally {
      this.activeStagedTurn = previous;
    }
  }
}

export function createScaffoldedActor<
  TObservation,
  TPending,
  TCommand,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
>(
  options: ScaffoldedActorOptions<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
): ScaffoldedSocialActor<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice> {
  return new ScaffoldedSocialActor(options);
}
