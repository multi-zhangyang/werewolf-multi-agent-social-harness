import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, PlayerView, Role } from "../core/types";
import { updateBeliefs } from "./belief";
import { hashStableState } from "./hash";
import { planAction } from "./policy";
import type { SocialMessage, SocialSpeechAct } from "./social";
import { hydrateSeenSocialMessageIds, ingestVisibleSocialMessages } from "./socialObservationIngestor";
import {
  addSocialGossip,
  appendSocialMemory,
  createAgentSocialState,
  pushSocialGoal,
  setSocialLastPlan,
  upsertSocialBelief,
  type AgentSocialState,
  type EvidenceRef,
  type SocialStateMutationContext,
} from "./socialState";
import type { AgentHarnessState, HarnessPlayerView, PolicyPlan, ReasonerActionProposal } from "./types";

interface ObserveContext {
  traceId: string;
  turnIndex: number;
}

interface CommitContext extends ObserveContext {
  pendingAction: AgentPendingAction;
  providerRequestId?: string;
}

export class WerewolfAgentActor {
  private latestView?: PlayerView;
  private latestObserveContext?: ObserveContext;
  private readonly seenMessageIds = new Set<string>();

  constructor(public readonly state: AgentHarnessState) {
    this.ensureSocialState();
    this.hydrateSeenMessageIds();
    this.updateSocialHash();
  }

  observe(view: PlayerView | HarnessPlayerView, context?: ObserveContext): void {
    this.latestView = view;
    this.latestObserveContext = context;
    this.state.observations += 1;
    this.state.beliefs = updateBeliefs(view, this.state.beliefs);
    this.recordObservation(view, context);
    this.recordVisibleSocialMessages(view, context);
    this.recordGenericBeliefs(view, context);
    this.ensureEpisodeGoal(view, context);
    this.updateSocialHash();
  }

  plan(action: AgentPendingAction): PolicyPlan {
    if (!this.latestView) {
      throw new Error(`Agent ${this.state.playerId} cannot plan without first observing.`);
    }
    const plan = planAction(this.latestView, action, this.state);
    return plan;
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
      if (proposal.poisonTargetId && !pending.legalPoisonTargetIds.includes(proposal.poisonTargetId)) return plan;
      next.command = {
        type: "witch.act",
        actorId: pending.actorId,
        saveTargetId: proposal.saveTargetId,
        poisonTargetId: proposal.poisonTargetId
      };
      next.targetId = proposal.saveTargetId ?? proposal.poisonTargetId;
    } else if (pending.kind === "vote" && next.command.type === "vote.cast") {
      if (!targetId && proposal.abstain === undefined && !next.command.abstain) return plan;
      next.command = targetId
        ? { type: "vote.cast", actorId: pending.actorId, targetId }
        : { type: "vote.cast", actorId: pending.actorId, abstain: proposal.abstain ?? next.command.abstain };
      next.targetId = targetId;
    } else if (pending.kind === "sheriff_vote" && next.command.type === "sheriff.vote") {
      if (!targetId && proposal.abstain === undefined && !next.command.abstain) return plan;
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

  commitTurn(plan: PolicyPlan, privateMemo: string, context?: CommitContext): void {
    if (!this.latestView) {
      throw new Error(`Agent ${this.state.playerId} cannot commit a turn without an observation.`);
    }
    this.state.turns += 1;
    this.state.lastIntent = plan.intent;
    this.state.privateMemos.push(privateMemo);
    this.state.privateMemos = this.state.privateMemos.slice(-20);
    const social = this.ensureSocialState();
    setSocialLastPlan(
      social,
      plan,
      [observationEvidence(this.state.observations, this.latestObserveContext)],
      socialMutationContext(this.latestView, this.latestObserveContext),
      {
        pendingActionKind: context?.pendingAction.kind,
        commandType: plan.command.type
      }
    );
    appendSocialMemory(social, {
      kind: "memo",
      source: "reasoner",
      visibility: "private",
      content: privateMemo,
      salience: 0.7,
      importance: 0.6,
      pendingAction: cloneJson(context?.pendingAction),
      evidenceRefs: [traceEvidence(context, `reasoner memo for ${plan.command.type}`)],
      tags: ["reasoner-memo", `command:${plan.command.type}`],
      metadata: {
        intent: plan.intent,
        policyName: plan.policyName,
        confidence: plan.confidence,
        strategyTags: plan.strategyTags,
        providerRequestId: context?.providerRequestId,
        turnIndex: context?.turnIndex
      }
    }, mutationContextFromPending(context));
    appendSocialMemory(social, {
      kind: "decision",
      source: "policy",
      visibility: "private",
      action: {
        actorId: this.state.playerId,
        kind: plan.command.type,
        command: cloneJson(plan.command)
      },
      salience: 0.8,
      importance: 0.7,
      pendingAction: cloneJson(context?.pendingAction),
      evidenceRefs: [traceEvidence(context, `policy ${plan.policyName} selected ${plan.command.type}`)],
      tags: ["policy-decision", `command:${plan.command.type}`, ...plan.strategyTags],
      metadata: {
        intent: plan.intent,
        confidence: plan.confidence,
        targetId: plan.targetId,
        claimedRole: plan.claimedRole,
        pressureTargetId: plan.pressureTargetId,
        arbitration: cloneJson(plan.arbitration)
      }
    }, mutationContextFromPending(context));
    this.updateSocialHash();
  }

  /**
   * Compute the serializable post-commit state hash without mutating this
   * actor. The harness uses this while assembling an action artifact; receipt
   * delivery must not be able to rewrite that artifact after the environment
   * has accepted the command.
   */
  previewCommittedStateHash(plan: PolicyPlan, privateMemo: string, context?: CommitContext): string {
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
      }
    });
    return this.state.social;
  }

  private recordObservation(view: PlayerView | HarnessPlayerView, context?: ObserveContext): void {
    const evidence = observationEvidence(this.state.observations, context);
    appendSocialMemory(this.ensureSocialState(), {
      kind: "observation",
      source: "environment",
      visibility: "private",
      observation: cloneJson(view),
      salience: 0.6,
      importance: view.pendingAction.kind === "speech" ? 0.5 : 0.7,
      evidenceRefs: [evidence],
      tags: [`phase:${view.phase}`, `action:${view.pendingAction.kind}`, `day:${view.day}`],
      metadata: {
        day: view.day,
        phase: view.phase,
        pendingActionKind: view.pendingAction.kind,
        visibleMessageCount: getVisibleSocialMessages(view).length,
        traceId: context?.traceId,
        turnIndex: context?.turnIndex
      }
    }, socialMutationContext(view, context));
  }

  private recordVisibleSocialMessages(view: PlayerView, context?: ObserveContext): void {
    const social = this.ensureSocialState();
    ingestVisibleSocialMessages({
      social,
      observerId: this.state.playerId,
      messages: getVisibleSocialMessages(view),
      seenMessageIds: this.seenMessageIds,
      context: socialMutationContext(view, context),
      additionalMessageTags: messageTags,
      onMessageIngested: ({ social: stagedSocial, message, evidence, context: mutationContext }) => {
        if (message.senderId !== this.state.playerId) {
          recordSocialMessageBeliefs(stagedSocial, message, evidence, this.state.playerId, mutationContext);
        }
      }
    });
  }

  private recordGenericBeliefs(view: PlayerView, context?: ObserveContext): void {
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

  private ensureEpisodeGoal(view: PlayerView, context?: ObserveContext): void {
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

function legalTargetIdsForPending(action: AgentPendingAction): string[] {
  if (action.kind === "witch") return action.legalPoisonTargetIds;
  if (action.kind === "speech") return action.legalPressureTargetIds;
  if (action.kind === "last_words") return [];
  return action.legalTargetIds;
}

function observationEvidence(seq: number, context?: ObserveContext): EvidenceRef {
  return {
    artifact: "observation",
    seq,
    traceId: context?.traceId,
    description: context ? `scoped player view turn ${context.turnIndex}` : "scoped player view"
  };
}

function traceEvidence(context: CommitContext | undefined, description: string): EvidenceRef {
  return {
    artifact: context ? "trace" : "memory",
    traceId: context?.traceId,
    seq: context?.turnIndex,
    description
  };
}

function socialMutationContext(
  view: PlayerView | HarnessPlayerView,
  context?: ObserveContext,
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

function mutationContextFromPending(context?: CommitContext): SocialStateMutationContext | undefined {
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
  evidence: EvidenceRef,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  const recordedKeys = new Set<string>();
  recordSpeechActBeliefs(social, message, evidence, observerId, context, recordedKeys, { explicitOnly: true });
  recordRoleClaimBelief(social, message, evidence, observerId, context, recordedKeys);
  recordPressureTargetBelief(social, message, evidence, observerId, context, recordedKeys);
  recordPublicVoteBelief(social, message, evidence, observerId, context, recordedKeys);
  recordHunterShotBelief(social, message, evidence, observerId, context, recordedKeys);
  recordWolfKillPreferenceBelief(social, message, evidence, observerId, context, recordedKeys);
  recordSpeechActBeliefs(social, message, evidence, observerId, context, recordedKeys, { explicitOnly: false });
}

function recordSpeechActBeliefs(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidence: EvidenceRef,
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
      recordSpeechActRoleClaim(social, message, act, actIndex, evidence, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "accusation") {
      recordSpeechActAccusation(social, message, act, actIndex, evidence, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "vote_intent") {
      recordSpeechActVoteIntent(social, message, act, actIndex, evidence, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "role_action") {
      recordSpeechActRoleAction(social, message, act, actIndex, evidence, observerId, context, recordedKeys);
      continue;
    }
    if (act.kind === "coalition_signal") {
      recordSpeechActCoalitionSignal(social, message, act, actIndex, evidence, observerId, context, recordedKeys);
      continue;
    }
  }
}

function recordSpeechActRoleClaim(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId: stringMetadata(act.targetId),
      assertedClaimOnly: true
    })
  }, context);
}

function recordSpeechActAccusation(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  act: SocialSpeechAct,
  actIndex: number,
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
    metadata: speechActClaimMetadata(message, act, actIndex, observerId, {
      targetId,
      observedActionOnly: true
    })
  }, context);
}

function recordRoleClaimBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
    metadata: {
      observerId,
      speakerId: message.senderId,
      claimSource: "social-message",
      claimKind: message.metadata?.kind,
      channelId: message.channelId,
      visibility: message.visibility,
      messageId: message.id,
      messageSeq: message.seq,
      assertedClaimOnly: true
    }
  }, context);
}

function recordPressureTargetBelief(
  social: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>,
  message: ReturnType<typeof getVisibleSocialMessages>[number],
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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
  evidence: EvidenceRef,
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
    evidenceRefs: [evidence],
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

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
