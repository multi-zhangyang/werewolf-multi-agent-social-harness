import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, PendingAction, PlayerView, Role } from "../core/types";
import { updateBeliefs } from "./belief";
import { hashStableState } from "./hash";
import { planAction } from "./policy";
import type { SocialActorStepReceipt, SocialDeliveryReceipt, SocialMessage, SocialSpeechAct } from "./social";
import { hydrateSeenSocialMessageIds, ingestVisibleSocialMessages } from "./socialObservationIngestor";
import {
  addSocialGossip,
  addSocialBetrayal,
  addSocialCommitment,
  appendSocialMemory,
  createAgentSocialState,
  pushSocialGoal,
  retrieveMemoryContext,
  setSocialLastPlan,
  updateSocialCommitmentStatus,
  updateSocialGoalStatus,
  updateSocialReputation,
  upsertSocialBelief,
  type AgentSocialState,
  type EvidenceRef,
  type MemoryRetrievalRecord,
  type SocialStateMutationContext,
} from "./socialState";
import type { AgentHarnessState, HarnessPlayerView, PolicyPlan, ReasonerActionProposal, ReasonerMemoryEntry } from "./types";

export const WEREWOLF_AGENT_MEMORY_MAX_ENTRIES = 64;
export const WEREWOLF_AGENT_JOURNAL_MAX_ENTRIES = 64;

export interface WerewolfAgentObserveContext {
  traceId: string;
  turnIndex: number;
}

export interface WerewolfAgentCommitContext extends WerewolfAgentObserveContext {
  pendingAction: AgentPendingAction;
}

export class WerewolfAgentActor {
  private latestView?: PlayerView;
  private latestObserveContext?: WerewolfAgentObserveContext;
  private readonly seenMessageIds = new Set<string>();

  constructor(public readonly state: AgentHarnessState) {
    this.ensureSocialState();
    this.hydrateSeenMessageIds();
    this.updateSocialHash();
  }

  observe(view: PlayerView | HarnessPlayerView, context?: WerewolfAgentObserveContext): void {
    this.latestView = view;
    this.latestObserveContext = context;
    this.state.observations += 1;
    this.state.beliefs = updateBeliefs(view, this.state.beliefs);
    this.recordObservation(view, context);
    this.recordVisibleSocialMessages(view, context);
    this.resolvePublicRoleClaimConsequences(view, context);
    this.recordGenericBeliefs(view, context);
    this.ensureEpisodeGoal(view, context);
    this.updateSocialHash();
  }

  plan(action: AgentPendingAction): PolicyPlan {
    if (!this.latestView) {
      throw new Error(`Agent ${this.state.playerId} cannot plan without first observing.`);
    }
    const recalled = retrieveMemoryContext(this.ensureSocialState().memory, {
      actorId: this.state.playerId,
      traceId: this.latestObserveContext?.traceId,
      // The first contract intentionally has no domain-specific semantic
      // query: all recall remains actor-scoped and uses the store's stable
      // importance/salience/recency ranking.
      limit: 6
    });
    const plan = planAction(this.latestView, action, this.state);
    return {
      ...plan,
      memoryRetrieval: recalled.evidence
    };
  }

  /**
   * Return only the selected actor-owned recall entries for optional reasoner
   * context. The reasoner receives clones and cannot mutate durable memory.
   */
  reasonerMemoryEntries(retrieval: MemoryRetrievalRecord | undefined): ReasonerMemoryEntry[] {
    if (!retrieval) return [];
    if (retrieval.actorId !== this.state.playerId) {
      throw new Error(`Memory retrieval belongs to ${retrieval.actorId}, expected ${this.state.playerId}.`);
    }
    const bySeq = new Map(this.ensureSocialState().memory.entries.map((entry) => [entry.seq, entry]));
    return retrieval.selected.flatMap((selection) => {
      const entry = bySeq.get(selection.memorySeq);
      if (!entry) return [];
      return [
        {
          memorySeq: entry.seq,
          kind: entry.kind,
          source: entry.source,
          visibility: entry.visibility,
          tags: [...entry.tags],
          content: entry.content ? entry.content.slice(0, 480) : undefined
        }
      ];
    });
  }

  act(plan: PolicyPlan): GameCommand {
    return plan.command;
  }

  /**
   * Merge an optional reasoner candidate without handing it environment
   * authority. The policy still fixes the action kind; only a target/resource
   * choice inside the pending legal set may be considered.
   */
  applyReasonerProposal(
    plan: PolicyPlan,
    pending: AgentPendingAction,
    proposal: ReasonerActionProposal | undefined
  ): PolicyPlan {
    return applyWerewolfReasonerProposal(plan, pending, proposal);
  }

  commitTurn(plan: PolicyPlan, privateMemo: string, context?: WerewolfAgentCommitContext): void {
    if (!this.latestView) {
      throw new Error(`Agent ${this.state.playerId} cannot commit a turn without an observation.`);
    }
    commitWerewolfAgentTurn({
      state: this.state,
      view: this.latestView,
      observeContext: this.latestObserveContext,
      plan,
      privateMemo,
      context
    });
  }

  /**
   * Compute the serializable post-commit state hash without mutating this
   * actor. The harness uses this while assembling an action artifact; receipt
   * delivery must not be able to rewrite that artifact after the environment
   * has accepted the command.
   */
  previewCommittedStateHash(plan: PolicyPlan, privateMemo: string, context?: WerewolfAgentCommitContext): string {
    if (!this.latestView) {
      throw new Error(`Agent ${this.state.playerId} cannot preview a committed turn without an observation.`);
    }
    const preview = new WerewolfAgentActor(cloneJson(this.state));
    preview.latestView = cloneJson(this.latestView);
    preview.latestObserveContext = cloneJson(this.latestObserveContext);
    preview.commitTurn(cloneJson(plan), privateMemo, cloneJson(context));
    const hash = preview.state.socialStateHash;
    if (!hash) throw new Error(`Agent ${this.state.playerId} did not produce a preview social state hash.`);
    return hash;
  }

  private ensureSocialState(): NonNullable<AgentHarnessState["social"]> {
    this.state.social ??= createAgentSocialState({
      agentId: this.state.playerId,
      profile: {
        id: this.state.profileId ?? this.state.playerId,
        model: this.state.model,
        temperature: this.state.temperature,
        policyId: this.state.policyName
      },
      maxMemoryEntries: WEREWOLF_AGENT_MEMORY_MAX_ENTRIES,
      maxJournalEntries: WEREWOLF_AGENT_JOURNAL_MAX_ENTRIES
    });
    return this.state.social;
  }

  private recordObservation(view: PlayerView | HarnessPlayerView, context?: WerewolfAgentObserveContext): void {
    const evidence = observationEvidence(this.state.observations, context);
    appendSocialMemory(this.ensureSocialState(), {
      kind: "observation",
      source: "environment",
      visibility: "private",
      // The canonical step artifact already retains the exact scoped
      // observation. Durable actor memory keeps a bounded core projection and
      // the trace evidence ref instead of recursively copying every prior
      // speech, vote, event, and social message into every later snapshot.
      // Message bodies are persisted once as typed message-memory entries.
      observation: werewolfObservationMemoryProjection(view),
      salience: 0.6,
      importance: view.pendingAction.kind === "speech" ? 0.5 : 0.7,
      evidenceRefs: [evidence],
      tags: [`phase:${view.phase}`, `action:${view.pendingAction.kind}`, `day:${view.day}`],
      metadata: {
        day: view.day,
        phase: view.phase,
        pendingActionKind: view.pendingAction.kind,
        visibleMessageCount: getVisibleSocialMessages(view).length,
        observationProjection: "werewolf.memory-core.v1",
        publicSpeechCount: view.speeches.length,
        voteCount: view.votes.length,
        deathCount: view.deaths.length,
        recentEventCount: view.recentEvents.length,
        traceId: context?.traceId,
        turnIndex: context?.turnIndex
      }
    }, socialMutationContext(view, context));
  }

  private recordVisibleSocialMessages(view: PlayerView, context?: WerewolfAgentObserveContext): void {
    const social = this.ensureSocialState();
    ingestVisibleSocialMessages({
      social,
      observerId: this.state.playerId,
      messages: getVisibleSocialMessages(view),
      seenMessageIds: this.seenMessageIds,
      context: socialMutationContext(view, context),
      additionalMessageTags: messageTags,
      onMessageIngested: ({ social: stagedSocial, message, evidenceRefs, deliveryReceipt, context: mutationContext }) => {
        if (message.senderId !== this.state.playerId) {
          recordSocialMessageBeliefs(stagedSocial, message, evidenceRefs, this.state.playerId, mutationContext);
        }
        reduceVisibleWerewolfSocialMessage(
          stagedSocial,
          message,
          evidenceRefs,
          deliveryReceipt,
          mutationContext
        );
      }
    });
  }

  private resolvePublicRoleClaimConsequences(view: PlayerView, context?: WerewolfAgentObserveContext): void {
    reducePublicWerewolfRoleClaimConsequences(
      this.ensureSocialState(),
      view,
      this.state.playerId,
      observationEvidence(this.state.observations, context),
      socialMutationContext(view, context)
    );
  }

  private recordGenericBeliefs(view: PlayerView, context?: WerewolfAgentObserveContext): void {
    const social = this.ensureSocialState();
    const evidence = observationEvidence(this.state.observations, context);
    for (const [playerId, belief] of Object.entries(this.state.beliefs)) {
      upsertSocialBelief(social, {
        subject: playerId,
        predicate: "werewolfProbability",
        value: belief.wolfProb,
        confidence: Math.min(1, Math.abs(belief.wolfProb - 0.5) * 2),
        evidenceRefs: [evidence],
        metadata: {
          rationaleTags: belief.rationaleTags,
          roleGuess: belief.roleGuess,
          observerId: this.state.playerId,
          day: view.day,
          phase: view.phase
        }
      }, socialMutationContext(view, context));
    }
  }

  private ensureEpisodeGoal(view: PlayerView, context?: WerewolfAgentObserveContext): void {
    const social = this.ensureSocialState();
    if (social.goals.goals.some((goal) => goal.id === "episode-win-condition")) return;
    pushSocialGoal(social, {
      id: "episode-win-condition",
      kind: "episode",
      description: "advance the private win condition through legal play",
      priority: 0.9,
      evidenceRefs: [observationEvidence(this.state.observations)],
      metadata: {
        role: view.you.role,
        team: view.you.team
      }
    }, socialMutationContext(view, context));
  }

  private updateSocialHash(): void {
    this.state.socialStateHash = hashStableState(this.ensureSocialState());
  }

  private hydrateSeenMessageIds(): void {
    hydrateSeenSocialMessageIds(this.ensureSocialState(), this.seenMessageIds);
  }
}

const WEREWOLF_COMMITMENT_REDUCER_VERSION = "werewolf.social-commitment-reducer.v1" as const;
const WEREWOLF_PUBLIC_ROLE_CLAIM_REDUCER_VERSION = "werewolf.public-role-claim-reducer.v1" as const;
const FALSE_PUBLIC_ROLE_CLAIM_HONESTY_DELTA = -0.25;

type ResolvableVoteCommitment = {
  promisedAction: "vote.cast" | "vote.abstain" | "sheriff.vote" | "sheriff.vote.abstain";
  targetId?: string;
  deadlinePhase: "day_vote" | "sheriff_vote";
  deadlineDay: number;
};

type WerewolfTypedMessage = Pick<
  SocialMessage,
  "senderId" | "recipientIds" | "runtimeAudienceIds" | "visibility" | "speechActs" | "metadata"
>;

/**
 * Reduce only an environment-committed Werewolf action into durable social
 * state. Message text and model self-reports are intentionally ignored.
 */
export function reduceCommittedWerewolfSocialAction(
  social: AgentSocialState,
  receipt: SocialActorStepReceipt<unknown, PendingAction, GameCommand>
): void {
  if (receipt.status !== "committed" || !receipt.action) return;
  const evidenceRefs: EvidenceRef[] = [
    {
      artifact: "outcome",
      id: receipt.id,
      traceId: receipt.traceId,
      seq: receipt.turnIndex,
      description: "committed-receipt"
    },
    {
      artifact: "action",
      id: receipt.action.traceId ?? receipt.traceId,
      traceId: receipt.traceId,
      seq: receipt.turnIndex,
      description: receipt.action.kind
    }
  ];
  const context = committedReceiptMutationContext(receipt);

  for (const message of receipt.action.messages ?? []) {
    reduceTypedCommitmentDeclarations(social, message, evidenceRefs, context);
    const outcome = typedVoteOutcome(message);
    if (outcome) resolveWerewolfVoteCommitments(social, message.senderId, outcome, evidenceRefs, context);
  }
}

function reduceVisibleWerewolfSocialMessage(
  social: AgentSocialState,
  message: SocialMessage,
  evidenceRefs: readonly EvidenceRef[],
  deliveryReceipt: SocialDeliveryReceipt | undefined,
  context: SocialStateMutationContext
): void {
  if (!deliveryReceipt) return;
  reduceTypedCommitmentDeclarations(social, message, evidenceRefs, context);
  const outcome = typedVoteOutcome(message);
  if (outcome) resolveWerewolfVoteCommitments(social, message.senderId, outcome, evidenceRefs, context);
}

function reduceTypedCommitmentDeclarations(
  social: AgentSocialState,
  message: WerewolfTypedMessage,
  evidenceRefs: readonly EvidenceRef[],
  context: SocialStateMutationContext
): void {
  for (const act of message.speechActs ?? []) {
    if (act.kind !== "commitment") continue;
    const commitmentId = stringMetadata(act.metadata?.commitmentId);
    const actorId = stringMetadata(act.subjectId);
    const declaration = resolvableVoteCommitment(act);
    if (!commitmentId || !actorId || actorId !== message.senderId || !declaration) continue;
    const goalId = `${commitmentId}:goal`;
    if (!social.commitments?.records[commitmentId]) {
      addSocialCommitment(social, {
        id: commitmentId,
        actorId,
        audienceIds: [...new Set(message.runtimeAudienceIds ?? message.recipientIds)].sort(),
        visibility: message.visibility,
        promisedAction: declaration.promisedAction,
        targetId: declaration.targetId,
        deadlinePhase: declaration.deadlinePhase,
        deadlineDay: declaration.deadlineDay,
        status: "active",
        confidence: numberMetadata(act.confidence) ?? 1,
        evidenceRefs: [...evidenceRefs],
        metadata: {
          version: WEREWOLF_COMMITMENT_REDUCER_VERSION,
          linkedGoalId: goalId,
          source: "typed-speech-act"
        }
      }, context);
    }
    if (!social.goals.goals.some((goal) => goal.id === goalId)) {
      pushSocialGoal(social, {
        id: goalId,
        kind: "commitment",
        description: `honor ${declaration.promisedAction}${declaration.targetId ? ` for ${declaration.targetId}` : ""}`,
        priority: 0.8,
        evidenceRefs: [...evidenceRefs],
        metadata: {
          version: WEREWOLF_COMMITMENT_REDUCER_VERSION,
          commitmentId,
          actorId,
          promisedAction: declaration.promisedAction,
          targetId: declaration.targetId,
          deadlinePhase: declaration.deadlinePhase,
          deadlineDay: declaration.deadlineDay
        }
      }, context);
    }
  }
}

function resolveWerewolfVoteCommitments(
  social: AgentSocialState,
  actorId: string,
  outcome: ResolvableVoteCommitment,
  evidenceRefs: readonly EvidenceRef[],
  context: SocialStateMutationContext
): void {
  for (const commitment of Object.values(social.commitments?.records ?? {})) {
    if (
      commitment.actorId !== actorId ||
      commitment.status !== "active" ||
      commitment.deadlinePhase !== outcome.deadlinePhase ||
      commitment.deadlineDay !== outcome.deadlineDay ||
      !isResolvableVoteAction(commitment.promisedAction)
    ) continue;
    const fulfilled = commitment.promisedAction === outcome.promisedAction && commitment.targetId === outcome.targetId;
    const status = fulfilled ? "fulfilled" : "broken";
    updateSocialCommitmentStatus(social, {
      id: commitment.id,
      status,
      evidenceRefs: [...evidenceRefs],
      metadata: {
        version: WEREWOLF_COMMITMENT_REDUCER_VERSION,
        resolutionSource: "committed-typed-vote",
        observedAction: outcome.promisedAction,
        observedTargetId: outcome.targetId
      }
    }, context);
    const goalId = stringMetadata(commitment.metadata?.linkedGoalId) ?? `${commitment.id}:goal`;
    if (social.goals.goals.some((goal) => goal.id === goalId && goal.status === "active")) {
      updateSocialGoalStatus(social, {
        id: goalId,
        status: fulfilled ? "completed" : "failed",
        evidenceRefs: [...evidenceRefs],
        metadata: {
          version: WEREWOLF_COMMITMENT_REDUCER_VERSION,
          commitmentId: commitment.id,
          resolutionSource: "committed-typed-vote"
        }
      }, context);
    }
  }
}

function resolvableVoteCommitment(act: SocialSpeechAct): ResolvableVoteCommitment | undefined {
  const promisedAction = stringMetadata(act.metadata?.promisedAction) ?? stringMetadata(act.value);
  if (!isResolvableVoteAction(promisedAction)) return undefined;
  const deadlineDay = numberMetadata(act.metadata?.deadlineDay);
  if (!Number.isInteger(deadlineDay) || deadlineDay! < 1) return undefined;
  const expectedPhase = promisedAction.startsWith("sheriff.") ? "sheriff_vote" : "day_vote";
  const deadlinePhase = stringMetadata(act.metadata?.deadlinePhase) ?? expectedPhase;
  if (deadlinePhase !== expectedPhase) return undefined;
  const targetId = stringMetadata(act.targetId) ?? stringMetadata(act.metadata?.targetId);
  if ((promisedAction === "vote.cast" || promisedAction === "sheriff.vote") && !targetId) return undefined;
  if ((promisedAction === "vote.abstain" || promisedAction === "sheriff.vote.abstain") && targetId) return undefined;
  return { promisedAction, targetId, deadlinePhase, deadlineDay: deadlineDay! };
}

function typedVoteOutcome(message: WerewolfTypedMessage): ResolvableVoteCommitment | undefined {
  if (message.visibility !== "public") return undefined;
  const messageKind = stringMetadata(message.metadata?.kind);
  const expectedFamily = messageKind === "public-vote"
    ? { cast: "vote.cast" as const, abstain: "vote.abstain" as const, phase: "day_vote" as const }
    : messageKind === "public-sheriff-vote"
      ? { cast: "sheriff.vote" as const, abstain: "sheriff.vote.abstain" as const, phase: "sheriff_vote" as const }
      : undefined;
  if (!expectedFamily) return undefined;
  const deadlineDay = numberMetadata(message.metadata?.day);
  if (!Number.isInteger(deadlineDay) || deadlineDay! < 1) return undefined;
  const typedVotes = (message.speechActs ?? []).filter((act) => act.kind === "vote_intent");
  if (typedVotes.length !== 1) return undefined;
  const act = typedVotes[0];
  if (stringMetadata(act.subjectId) !== message.senderId) return undefined;
  const targetId = stringMetadata(act.targetId);
  const value = stringMetadata(act.value);
  const metadataTargetId = stringMetadata(message.metadata?.targetId);
  const metadataAbstain = message.metadata?.abstain === true;
  if (value === expectedFamily.cast && targetId && targetId === metadataTargetId && !metadataAbstain) {
    return {
      promisedAction: expectedFamily.cast,
      targetId,
      deadlinePhase: expectedFamily.phase,
      deadlineDay: deadlineDay!
    };
  }
  if (value === expectedFamily.abstain && !targetId && !metadataTargetId && metadataAbstain) {
    return {
      promisedAction: expectedFamily.abstain,
      deadlinePhase: expectedFamily.phase,
      deadlineDay: deadlineDay!
    };
  }
  return undefined;
}

function isResolvableVoteAction(value: unknown): value is ResolvableVoteCommitment["promisedAction"] {
  return value === "vote.cast" || value === "vote.abstain" || value === "sheriff.vote" || value === "sheriff.vote.abstain";
}

function reducePublicWerewolfRoleClaimConsequences(
  social: AgentSocialState,
  view: PlayerView,
  observerId: string,
  publicObservationEvidence: EvidenceRef,
  context: SocialStateMutationContext
): void {
  for (const claim of Object.values(social.beliefs.claims)) {
    if (claim.predicate !== "claimedRole" || claim.subject === observerId) continue;
    const claimedRole = roleMetadata(claim.value);
    const revealedRole = view.publicPlayers.find((player) => player.id === claim.subject)?.revealedRole;
    const messageId = stringMetadata(claim.metadata?.messageId);
    const deliveryReceiptId = stringMetadata(claim.metadata?.sourceDeliveryReceiptId);
    if (
      !claimedRole ||
      !revealedRole ||
      claimedRole === revealedRole ||
      claim.metadata?.visibility !== "public" ||
      !messageId ||
      !deliveryReceiptId
    ) continue;
    const messageEvidence = claim.evidenceRefs.find((ref) => ref.artifact === "message" && ref.id === messageId);
    const deliveryEvidence = claim.evidenceRefs.find(
      (ref) => ref.artifact === "delivery_receipt" && ref.id === deliveryReceiptId
    );
    if (!messageEvidence || !deliveryEvidence) continue;
    const betrayalId = `${observerId}:false-public-role-claim:${messageId}`;
    if (social.betrayals?.records[betrayalId]) continue;
    const evidenceRefs = [messageEvidence, deliveryEvidence, publicObservationEvidence];
    addSocialBetrayal(social, {
      id: betrayalId,
      actorId: claim.subject,
      targetId: observerId,
      audienceIds: [observerId],
      visibility: "public",
      kind: "deception",
      status: "confirmed",
      triggerKind: "other",
      triggerId: messageId,
      claim: `claimed role ${claimedRole}`,
      impact: `public role reveal was ${revealedRole}`,
      confidence: 1,
      evidenceRefs,
      metadata: {
        version: WEREWOLF_PUBLIC_ROLE_CLAIM_REDUCER_VERSION,
        source: "public-revealed-role",
        claimedRole,
        revealedRole,
        observerId,
        messageId,
        deliveryReceiptId
      }
    }, context);
    updateSocialReputation(social, {
      subjectId: claim.subject,
      deltas: { honesty: FALSE_PUBLIC_ROLE_CLAIM_HONESTY_DELTA },
      evidenceRefs,
      metadata: {
        version: WEREWOLF_PUBLIC_ROLE_CLAIM_REDUCER_VERSION,
        source: "confirmed-public-role-claim-mismatch",
        betrayalId,
        messageId,
        deliveryReceiptId
      }
    }, context);
  }
}

function committedReceiptMutationContext(
  receipt: SocialActorStepReceipt<unknown, PendingAction, GameCommand>
): SocialStateMutationContext {
  return {
    traceId: receipt.traceId,
    turnIndex: receipt.turnIndex,
    phase: receipt.pendingAction.phase,
    messageSeqRange: receipt.messageSeqRange
      ? { start: receipt.messageSeqRange[0], end: receipt.messageSeqRange[1] }
      : undefined
  };
}

/**
 * Domain-local, pure advisory merge shared by the legacy compatibility actor
 * and scaffold-backed actor policies. It preserves the existing rule that a
 * reasoner can only select within the policy's pending legal action family.
 */
export function applyWerewolfReasonerProposal(
  plan: PolicyPlan,
  pending: AgentPendingAction,
  proposal: ReasonerActionProposal | undefined
): PolicyPlan {
  if (!proposal) return plan;
  if (proposal.commandType && proposal.commandType !== plan.command.type) return plan;

  const legalTargetIds = legalTargetIdsForPending(pending);
  const next = cloneJson(plan);
  const targetId = proposal.targetId;
  if (targetId && !legalTargetIds.includes(targetId)) return plan;

  if (pending.kind === "speech" && targetId) {
    if (next.command.type !== "speech.submit") return plan;
    next.command.pressureTargetId = targetId;
    next.pressureTargetId = targetId;
    next.targetId = targetId;
  } else if (pending.kind === "witch") {
    if (next.command.type !== "witch.act") return plan;
    if (proposal.saveTargetId && (!pending.canSave || proposal.saveTargetId !== pending.nightVictimId)) return plan;
    if (
      proposal.poisonTargetId &&
      (!pending.canPoison || !pending.legalPoisonTargetIds.includes(proposal.poisonTargetId))
    ) return plan;
    next.command = {
      type: "witch.act",
      actorId: pending.actorId,
      saveTargetId: proposal.saveTargetId,
      poisonTargetId: proposal.poisonTargetId
    };
    next.targetId = proposal.saveTargetId ?? proposal.poisonTargetId;
  } else if (pending.kind === "vote" && next.command.type === "vote.cast") {
    if (!targetId && proposal.abstain !== true) return plan;
    next.command = targetId
      ? { type: "vote.cast", actorId: pending.actorId, targetId }
      : { type: "vote.cast", actorId: pending.actorId, abstain: proposal.abstain ?? next.command.abstain };
    next.targetId = targetId;
  } else if (pending.kind === "sheriff_vote" && next.command.type === "sheriff.vote") {
    if (!targetId && proposal.abstain !== true) return plan;
    next.command = targetId
      ? { type: "sheriff.vote", actorId: pending.actorId, targetId }
      : { type: "sheriff.vote", actorId: pending.actorId, abstain: proposal.abstain ?? next.command.abstain };
    next.targetId = targetId;
  } else if (pending.kind === "shoot" && next.command.type === "hunter.shoot") {
    next.command = { type: "hunter.shoot", actorId: pending.actorId, targetId };
    next.targetId = targetId;
  } else if (pending.kind === "inspect" && next.command.type === "seer.inspect" && targetId) {
    next.command = { type: "seer.inspect", actorId: pending.actorId, targetId };
    next.targetId = targetId;
  } else if (pending.kind === "kill" && next.command.type === "werewolf.killVote" && targetId) {
    next.command = { type: "werewolf.killVote", actorId: pending.actorId, targetId };
    next.targetId = targetId;
  } else {
    return plan;
  }

  next.reasonerProposal = cloneJson(proposal);
  next.strategyTags = uniqueStrings([...next.strategyTags, "reasoner-candidate"]);
  if (proposal.confidence !== undefined) next.confidence = Math.max(0, Math.min(1, proposal.confidence));
  if (proposal.rationale?.trim()) next.intent = `${next.intent}；候选理由：${proposal.rationale.trim()}`;
  return next;
}

/**
 * Apply a receipt-gated, already selected plan to one canonical Werewolf
 * agent state. The caller must invoke this only on a transaction-local clone
 * before `ScaffoldedSocialActor` receives a committed receipt.
 */
export function commitWerewolfAgentTurn(input: {
  state: AgentHarnessState;
  view: PlayerView | HarnessPlayerView;
  observeContext?: WerewolfAgentObserveContext;
  plan: PolicyPlan;
  privateMemo: string;
  context?: WerewolfAgentCommitContext;
}): void {
  input.state.turns += 1;
  input.state.lastIntent = input.plan.intent;
  input.state.privateMemos.push(input.privateMemo);
  input.state.privateMemos = input.state.privateMemos.slice(-20);
  const social = ensureWerewolfAgentSocialState(input.state);
  setSocialLastPlan(
    social,
    input.plan,
    [observationEvidence(input.state.observations, input.observeContext)],
    socialMutationContext(input.view, input.observeContext),
    {
      pendingActionKind: input.context?.pendingAction.kind,
      commandType: input.plan.command.type
    }
  );
  appendSocialMemory(social, {
    kind: "memo",
    source: "reasoner",
    visibility: "private",
    content: input.privateMemo,
    salience: 0.7,
    importance: 0.6,
    pendingAction: cloneJson(input.context?.pendingAction),
    evidenceRefs: [traceEvidence(input.context, `reasoner memo for ${input.plan.command.type}`)],
    tags: ["reasoner-memo", `command:${input.plan.command.type}`],
    metadata: {
      intent: input.plan.intent,
      policyName: input.plan.policyName,
      confidence: input.plan.confidence,
      strategyTags: input.plan.strategyTags,
      turnIndex: input.context?.turnIndex
    }
  }, mutationContextFromPending(input.context));
  appendSocialMemory(social, {
    kind: "decision",
    source: "policy",
    visibility: "private",
    action: {
      actorId: input.state.playerId,
      kind: input.plan.command.type,
      command: cloneJson(input.plan.command)
    },
    salience: 0.8,
    importance: 0.7,
    pendingAction: cloneJson(input.context?.pendingAction),
    evidenceRefs: [traceEvidence(input.context, `policy ${input.plan.policyName} selected ${input.plan.command.type}`)],
    tags: ["policy-decision", `command:${input.plan.command.type}`, ...input.plan.strategyTags],
    metadata: {
      intent: input.plan.intent,
      confidence: input.plan.confidence,
      targetId: input.plan.targetId,
      claimedRole: input.plan.claimedRole,
      pressureTargetId: input.plan.pressureTargetId,
      arbitration: cloneJson(input.plan.arbitration),
      memoryRetrieval: cloneJson(input.plan.memoryRetrieval)
    }
  }, mutationContextFromPending(input.context));
  input.state.socialStateHash = hashStableState(social);
}

function ensureWerewolfAgentSocialState(state: AgentHarnessState): NonNullable<AgentHarnessState["social"]> {
  state.social ??= createAgentSocialState({
    agentId: state.playerId,
    profile: {
      id: state.profileId ?? state.playerId,
      model: state.model,
      temperature: state.temperature,
      policyId: state.policyName
    }
  });
  return state.social;
}

function legalTargetIdsForPending(action: AgentPendingAction): string[] {
  if (action.kind === "witch") return action.legalPoisonTargetIds;
  if (action.kind === "speech") return action.legalPressureTargetIds;
  if (action.kind === "last_words" || action.kind === "whisper") return [];
  return action.legalTargetIds;
}

function observationEvidence(seq: number, context?: WerewolfAgentObserveContext): EvidenceRef {
  return {
    artifact: "observation",
    seq,
    traceId: context?.traceId,
    description: context ? `scoped player view turn ${context.turnIndex}` : "scoped player view"
  };
}

function traceEvidence(context: WerewolfAgentCommitContext | undefined, description: string): EvidenceRef {
  return {
    artifact: context ? "trace" : "memory",
    traceId: context?.traceId,
    seq: context?.turnIndex,
    description
  };
}

function socialMutationContext(
  view: PlayerView | HarnessPlayerView,
  context?: WerewolfAgentObserveContext,
  messageSeqRange?: { start: number; end: number }
): SocialStateMutationContext {
  return {
    traceId: context?.traceId,
    turnIndex: context?.turnIndex,
    phase: view.phase,
    day: view.day,
    messageSeqRange
  };
}

function mutationContextFromPending(context?: WerewolfAgentCommitContext): SocialStateMutationContext | undefined {
  if (!context) return undefined;
  return {
    traceId: context.traceId,
    turnIndex: context.turnIndex,
    phase: context.pendingAction.phase
  };
}

function getVisibleSocialMessages(view: PlayerView | HarnessPlayerView): SocialMessage[] {
  const social = (view as PlayerView & {
    social?: {
      messages?: SocialMessage[];
    };
  }).social;
  return social?.messages ?? [];
}

function messageTags(message: SocialMessage): string[] {
  const metadata = message.metadata;
  return uniqueStrings([
    roleMetadata(metadata?.claimedRole) ? "claim:role" : undefined,
    stringMetadata(metadata?.pressureTargetId) ? "claim:pressure" : undefined,
    metadata?.kind === "public-vote" ? "claim:vote" : undefined,
    metadata?.kind === "public-hunter-shot" ? "claim:hunter-shot" : undefined,
    metadata?.kind === "werewolf-kill-vote" ? "claim:wolf-kill-preference" : undefined
  ].filter((tag): tag is string => Boolean(tag)));
}

function recordSocialMessageBeliefs(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext
): void {
  const recordedKeys = new Set<string>();
  recordSpeechActBeliefs(social, message, evidenceRefs, observerId, context, recordedKeys, { explicitOnly: true });
  recordRoleClaimBelief(social, message, evidenceRefs, observerId, context, recordedKeys);
  recordPressureTargetBelief(social, message, evidenceRefs, observerId, context, recordedKeys);
  recordPublicVoteBelief(social, message, evidenceRefs, observerId, context, recordedKeys);
  recordHunterShotBelief(social, message, evidenceRefs, observerId, context, recordedKeys);
  recordWolfKillPreferenceBelief(social, message, evidenceRefs, observerId, context, recordedKeys);
  recordSpeechActBeliefs(social, message, evidenceRefs, observerId, context, recordedKeys, { explicitOnly: false });
}

function recordSpeechActBeliefs(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>,
  options: { explicitOnly: boolean }
): void {
  for (const [actIndex, act] of (message.speechActs ?? []).entries()) {
    const metadataDerived = isMetadataDerivedSpeechAct(act);
    if (options.explicitOnly && metadataDerived) continue;
    if (!options.explicitOnly && !metadataDerived) continue;

    if (act.kind === "role_claim") {
      recordSpeechActRoleClaim(social, message, act, actIndex, evidenceRefs, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "accusation") {
      recordSpeechActAccusation(social, message, act, actIndex, evidenceRefs, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "vote_intent") {
      recordSpeechActVoteIntent(social, message, act, actIndex, evidenceRefs, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "role_action") {
      recordSpeechActRoleAction(social, message, act, actIndex, evidenceRefs, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "coalition_signal") {
      recordSpeechActCoalitionSignal(social, message, act, actIndex, evidenceRefs, observerId, context, recordedKeys);
      continue;
    }
  }
}

function recordSpeechActRoleClaim(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>
): void {
  const claimedRole = roleMetadata(act.value);
  const subject = stringMetadata(act.subjectId) ?? message.senderId;
  if (!claimedRole || !tryMarkRecorded(recordedKeys, subject, "claimedRole")) return;
  upsertSocialBelief(social, {
    subject,
    predicate: "claimedRole",
    value: claimedRole,
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId: stringMetadata(act.targetId),
      sourceDeliveryReceiptId: evidenceRefs.find((ref) => ref.artifact === "delivery_receipt")?.id,
      assertedClaimOnly: true
    })
  }, context);
}

function recordSpeechActAccusation(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>
): void {
  const targetId = stringMetadata(act.targetId);
  if (!targetId || !tryMarkRecorded(recordedKeys, message.senderId, "pressuredTarget")) return;
  const confidence = numberMetadata(act.confidence) ?? 0.8;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "pressuredTarget",
    value: targetId,
    confidence,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId,
      assertedClaimOnly: true
    })
  }, context);
  const gossipId = `${message.id}:speech-act:${speechActId(act, actIndex)}:gossip`;
  if (social.gossip?.records[gossipId]) return;
  addSocialGossip(social, {
    id: gossipId,
    speakerId: message.senderId,
    subjectId: targetId,
    audienceIds: message.recipientIds,
    visibility: message.visibility,
    topic: "accusation",
    claim: stringMetadata(act.value) ?? `accusation against ${targetId}`,
    valence: "negative",
    confidence,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActFactMetadata(message, act, actIndex, observerId, {
      targetId
    })
  }, context);
}

function recordSpeechActVoteIntent(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>
): void {
  const messageKind = stringMetadata(message.metadata?.kind) ?? stringMetadata(act.metadata?.messageKind);
  const observedPublicVote = messageKind === "public-vote";
  const predicate = observedPublicVote ? "publicVoteTarget" : "voteIntentTarget";
  if (!tryMarkRecorded(recordedKeys, message.senderId, predicate)) return;
  const targetId = stringMetadata(act.targetId);
  const abstain = act.metadata?.abstain === true || act.value === "vote.abstain" || act.value === "abstain";
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate,
    value: targetId ?? "abstain",
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId,
      abstain: abstain || !targetId,
      observedActionOnly: observedPublicVote,
      assertedIntentOnly: !observedPublicVote
    })
  }, context);
}

function recordSpeechActRoleAction(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>
): void {
  if (act.value !== "hunter.shoot") return;
  const targetId = stringMetadata(act.targetId);
  if (!targetId || !tryMarkRecorded(recordedKeys, message.senderId, "hunterShotTarget")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "hunterShotTarget",
    value: targetId,
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId,
      observedActionOnly: true
    })
  }, context);
}

function recordSpeechActCoalitionSignal(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context: SocialStateMutationContext | undefined,
  recordedKeys: Set<string>
): void {
  if (act.value !== "werewolf.killVote") return;
  const targetId = stringMetadata(act.targetId);
  if (!targetId || !tryMarkRecorded(recordedKeys, message.senderId, "wolfKillPreference")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "wolfKillPreference",
    value: targetId,
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [...evidenceRefs],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId,
      observedActionOnly: true
    })
  }, context);
}

function recordRoleClaimBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext,
  recordedKeys?: Set<string>
): void {
  const claimedRole = roleMetadata(message.metadata?.claimedRole);
  if (!claimedRole) return;
  if (!tryMarkRecorded(recordedKeys, message.senderId, "claimedRole")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "claimedRole",
    value: claimedRole,
    confidence: 1,
    evidenceRefs: [...evidenceRefs],
    metadata: {
      observerId,
      speakerId: message.senderId,
      claimSource: "social-message",
      claimKind: message.metadata?.kind,
      channelId: message.channelId,
      visibility: message.visibility,
      messageId: message.id,
      messageSeq: message.seq,
      sourceDeliveryReceiptId: evidenceRefs.find((ref) => ref.artifact === "delivery_receipt")?.id,
      assertedClaimOnly: true
    }
  }, context);
}

function recordPressureTargetBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext,
  recordedKeys?: Set<string>
): void {
  if (message.metadata?.kind !== "public-speech") return;
  const pressureTargetId = stringMetadata(message.metadata?.pressureTargetId);
  if (!pressureTargetId) return;
  if (!tryMarkRecorded(recordedKeys, message.senderId, "pressuredTarget")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "pressuredTarget",
    value: pressureTargetId,
    confidence: 1,
    evidenceRefs: [...evidenceRefs],
    metadata: socialClaimMetadata(message, observerId, {
      claimKind: "public-speech",
      targetId: pressureTargetId,
      assertedClaimOnly: true
    })
  }, context);
}

function recordPublicVoteBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext,
  recordedKeys?: Set<string>
): void {
  if (message.metadata?.kind !== "public-vote") return;
  const targetId = stringMetadata(message.metadata?.targetId);
  const abstain = message.metadata?.abstain === true;
  if (!tryMarkRecorded(recordedKeys, message.senderId, "publicVoteTarget")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "publicVoteTarget",
    value: targetId ?? "abstain",
    confidence: 1,
    evidenceRefs: [...evidenceRefs],
    metadata: socialClaimMetadata(message, observerId, {
      claimKind: "public-vote",
      targetId,
      abstain,
      observedActionOnly: true
    })
  }, context);
}

function recordHunterShotBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext,
  recordedKeys?: Set<string>
): void {
  if (message.metadata?.kind !== "public-hunter-shot") return;
  const targetId = stringMetadata(message.metadata?.targetId);
  if (!tryMarkRecorded(recordedKeys, message.senderId, "hunterShotTarget")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "hunterShotTarget",
    value: targetId ?? "declined",
    confidence: 1,
    evidenceRefs: [...evidenceRefs],
    metadata: socialClaimMetadata(message, observerId, {
      claimKind: "public-hunter-shot",
      targetId,
      observedActionOnly: true
    })
  }, context);
}

function recordWolfKillPreferenceBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidenceRefs: readonly EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext,
  recordedKeys?: Set<string>
): void {
  if (message.metadata?.kind !== "werewolf-kill-vote") return;
  const targetId = stringMetadata(message.metadata?.targetId);
  if (!targetId) return;
  if (!tryMarkRecorded(recordedKeys, message.senderId, "wolfKillPreference")) return;
  upsertSocialBelief(social, {
    subject: message.senderId,
    predicate: "wolfKillPreference",
    value: targetId,
    confidence: 1,
    evidenceRefs: [...evidenceRefs],
    metadata: socialClaimMetadata(message, observerId, {
      claimKind: "werewolf-kill-vote",
      targetId,
      observedActionOnly: true
    })
  }, context);
}

function socialClaimMetadata(
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  observerId: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    observerId,
    speakerId: message.senderId,
    claimSource: "social-message",
    channelId: message.channelId,
    visibility: message.visibility,
    messageId: message.id,
    messageSeq: message.seq,
    ...extra
  };
}

function speechActClaimMetadata(
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  observerId: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return socialClaimMetadata(message, observerId, {
    claimSource: "social-message-speech-act",
    claimKind: message.metadata?.kind,
    speechActId: speechActId(act, actIndex),
    speechActKind: act.kind,
    speechActIndex: actIndex,
    speechActSubjectId: stringMetadata(act.subjectId),
    speechActSource: stringMetadata(act.metadata?.source),
    ...extra
  });
}

function speechActFactMetadata(
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  observerId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    observerId,
    speakerId: message.senderId,
    factSource: "social-message-speech-act",
    factKind: act.kind,
    speechActId: speechActId(act, actIndex),
    speechActKind: act.kind,
    speechActIndex: actIndex,
    speechActSubjectId: stringMetadata(act.subjectId),
    speechActSource: stringMetadata(act.metadata?.source),
    channelId: message.channelId,
    visibility: message.visibility,
    messageId: message.id,
    messageSeq: message.seq,
    ...extra
  };
}

function isMetadataDerivedSpeechAct(act: SocialSpeechAct): boolean {
  const source = stringMetadata(act.metadata?.source);
  return source?.startsWith("metadata.") === true;
}

function speechActId(act: SocialSpeechAct, actIndex: number): string {
  return act.id.trim() || `index-${actIndex}`;
}

function recordKey(subject: string, predicate: string): string {
  return `${subject}:${predicate}`;
}

function tryMarkRecorded(recordedKeys: Set<string> | undefined, subject: string, predicate: string): boolean {
  if (!recordedKeys) return true;
  const key = recordKey(subject, predicate);
  if (recordedKeys.has(key)) return false;
  recordedKeys.add(key);
  return true;
}

function roleMetadata(value: unknown): Role | undefined {
  if (
    value === "werewolf" ||
    value === "villager" ||
    value === "seer" ||
    value === "witch" ||
    value === "hunter"
  ) {
    return value;
  }
  return undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Bounded actor-memory projection. The exact observation remains in the
 * runner-owned step artifact and is addressed by the memory entry evidence
 * ref; cumulative transcript/event collections are intentionally not nested
 * again inside every durable agent snapshot.
 */
function werewolfObservationMemoryProjection(view: PlayerView | HarnessPlayerView): PlayerView {
  return {
    phase: view.phase,
    day: view.day,
    you: cloneJson(view.you),
    publicPlayers: cloneJson(view.publicPlayers),
    privateInfo: cloneJson(view.privateInfo),
    speeches: [],
    votes: [],
    deaths: cloneJson(view.deaths),
    recentEvents: [],
    pendingAction: cloneJson(view.pendingAction)
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
