import type { SocialAction, SocialActor, SocialActorObservationContext, SocialAgentProfile } from "./social";
import {
  extractVisibleSocialMessagesFromObservation,
  hydrateSeenSocialMessageIds,
  ingestVisibleSocialMessages
} from "./socialObservationIngestor";
import {
  appendSocialMemory,
  createAgentSocialState,
  type AgentSocialState,
  type BeliefClaim,
  type BetrayalKind,
  type BetrayalRecord,
  type BetrayalStatus,
  type CoalitionRecord,
  type CoalitionStatus,
  type CommitmentRecord,
  type CommitmentStatus,
  type EvidenceRef,
  type GoalRecord,
  type GossipRecord,
  type GossipValence,
  type MemoryVisibility,
  type NormSanctionKind,
  type NormSanctionRecord,
  type NormSanctionStatus,
  type NormRecord,
  type RelationshipEdge,
  type ReputationRecord,
  type SocialStateMutationContext,
  type TrustRepairKind,
  type TrustRepairRecord,
  type TrustRepairStatus
} from "./socialState";

export interface ScaffoldMemoryEntry<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  seq: number;
  kind: "observation" | "decision" | "memo";
  observation?: TObservation;
  pendingAction?: TPending;
  action?: SocialAction<TCommand>;
  content?: string;
  createdAt: string;
  source?: string;
  visibility?: MemoryVisibility;
  evidenceRefs?: EvidenceRef[];
  tags?: string[];
  salience?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentScaffoldState<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  profile: SocialAgentProfile;
  observations: number;
  decisions: number;
  memory: Array<ScaffoldMemoryEntry<TObservation, TPending, TCommand>>;
  social: AgentSocialState<TObservation, TPending, TCommand>;
  lastObservation?: TObservation;
  lastAction?: SocialAction<TCommand>;
}

export interface AgentDecisionInput<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  agent: AgentScaffoldState<TObservation, TPending, TCommand>;
  observation: TObservation;
  pendingAction: TPending;
}

export type AgentActionCandidateSource =
  | "policy"
  | "reasoner"
  | "memory"
  | "belief"
  | "relationship"
  | "reputation"
  | "norm"
  | "goal"
  | "social_state"
  | "other";

export interface AgentActionCandidate<TCommand = unknown> {
  id: string;
  actorId: string;
  kind: string;
  source: AgentActionCandidateSource | string;
  socialTargetIds?: string[];
  action: SocialAction<TCommand>;
  baseScore?: number;
  utilityScore?: number;
  socialScore?: number;
  riskPenalty?: number;
  legalityScore?: number;
  finalScore?: number;
  scoreContributions?: AgentActionCandidateScoreContribution[];
  reasons: string[];
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface AgentActionCandidateScoreContribution {
  scorerId: string;
  source: AgentActionCandidateSource | string;
  utilityScoreDelta?: number;
  socialScoreDelta?: number;
  riskPenaltyDelta?: number;
  legalityScoreDelta?: number;
  finalScoreDelta?: number;
  reasons: string[];
  evidenceRefs: EvidenceRef[];
}

export interface AgentActionCandidateSummary {
  id: string;
  actorId: string;
  kind: string;
  source: string;
  socialTargetIds?: string[];
  baseScore?: number;
  utilityScore?: number;
  socialScore?: number;
  riskPenalty?: number;
  legalityScore?: number;
  finalScore?: number;
  scoreContributions?: AgentActionCandidateScoreContribution[];
  reasons: string[];
  evidenceRefs: EvidenceRef[];
  messageCount: number;
}

export interface AgentActionArbitrationSummary {
  version: "agent.action-arbitration.v1";
  actorId: string;
  policyId: string;
  arbitratorId: string;
  selectedCandidateId: string;
  candidateCount: number;
  decisionRule: string;
  selectionReason?: string;
  selectionEvidenceRefs?: EvidenceRef[];
  candidates: AgentActionCandidateSummary[];
}

export interface AgentActionArbitrationInput<TObservation = unknown, TPending = unknown, TCommand = unknown>
  extends AgentDecisionInput<TObservation, TPending, TCommand> {
  policyId: string;
  reasonerMemo?: string;
  candidates: Array<AgentActionCandidate<TCommand>>;
}

export interface AgentActionArbitrationDecision {
  selectedCandidateId: string;
  decisionRule?: string;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
}

export interface AgentActionArbitrator<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  arbitrate(
    input: AgentActionArbitrationInput<TObservation, TPending, TCommand>
  ): AgentActionArbitrationDecision | Promise<AgentActionArbitrationDecision>;
}

export interface AgentActionCandidateScoringInput<TObservation = unknown, TPending = unknown, TCommand = unknown>
  extends AgentDecisionInput<TObservation, TPending, TCommand> {
  policyId: string;
  reasonerMemo?: string;
  candidate: AgentActionCandidate<TCommand>;
  candidates: Array<AgentActionCandidate<TCommand>>;
}

export interface AgentActionCandidateScorer<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  score(
    input: AgentActionCandidateScoringInput<TObservation, TPending, TCommand>
  ):
    | AgentActionCandidateScoreContribution
    | undefined
    | Promise<AgentActionCandidateScoreContribution | undefined>;
}

export type AgentRelationshipScoreField = "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat";
export type AgentReputationScoreField = "honesty" | "competence" | "cooperation" | "threat" | "normCompliance";

export interface WeightedSocialStateCandidateScorerOptions {
  id?: string;
  relationshipWeights?: Partial<Record<AgentRelationshipScoreField, number>>;
  reputationWeights?: Partial<Record<AgentReputationScoreField, number>>;
  beliefPredicateWeights?: Record<string, number>;
  activeGoalWeight?: number;
  activeNormWeight?: number;
  commitmentStatusWeights?: Partial<Record<CommitmentStatus, number>>;
  coalitionStatusWeights?: Partial<Record<CoalitionStatus, number>>;
  gossipValenceWeights?: Partial<Record<GossipValence, number>>;
  normSanctionKindWeights?: Partial<Record<NormSanctionKind, number>>;
  normSanctionStatusWeights?: Partial<Record<NormSanctionStatus, number>>;
  trustRepairKindWeights?: Partial<Record<TrustRepairKind, number>>;
  trustRepairStatusWeights?: Partial<Record<TrustRepairStatus, number>>;
  betrayalKindWeights?: Partial<Record<BetrayalKind, number>>;
  betrayalStatusWeights?: Partial<Record<BetrayalStatus, number>>;
}

export const WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND = "weighted-social-state";

export interface AgentActionCandidateScorerConfig {
  kind: string;
  options?: unknown;
}

export type AgentActionCandidateScorerFactory<TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  config: AgentActionCandidateScorerConfig
) => AgentActionCandidateScorer<TObservation, TPending, TCommand>;

export type AgentActionCandidateScorerRegistry<TObservation = unknown, TPending = unknown, TCommand = unknown> = Record<
  string,
  AgentActionCandidateScorerFactory<TObservation, TPending, TCommand>
>;

export interface AgentPolicy<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  decide(input: AgentDecisionInput<TObservation, TPending, TCommand>): SocialAction<TCommand>;
  generateCandidates?(input: AgentDecisionInput<TObservation, TPending, TCommand>): Array<AgentActionCandidate<TCommand>>;
}

export interface AgentReasoner<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  reflect(input: AgentDecisionInput<TObservation, TPending, TCommand>): Promise<string> | string;
}

export interface ScaffoldedActorOptions<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  profile: SocialAgentProfile;
  policy: AgentPolicy<TObservation, TPending, TCommand>;
  reasoner?: AgentReasoner<TObservation, TPending, TCommand>;
  candidateScorers?: Array<AgentActionCandidateScorer<TObservation, TPending, TCommand>>;
  actionArbitrator?: AgentActionArbitrator<TObservation, TPending, TCommand>;
  initialSocialState?: AgentSocialState<TObservation, TPending, TCommand>;
  maxMemoryEntries?: number;
}

export class ScaffoldedSocialActor<TObservation = unknown, TPending = unknown, TCommand = unknown>
  implements SocialActor<TObservation, TPending, TCommand>
{
  readonly id: string;
  readonly profile: SocialAgentProfile;
  readonly policy: AgentPolicy<TObservation, TPending, TCommand>;
  readonly reasoner?: AgentReasoner<TObservation, TPending, TCommand>;
  readonly candidateScorers: Array<AgentActionCandidateScorer<TObservation, TPending, TCommand>>;
  readonly actionArbitrator?: AgentActionArbitrator<TObservation, TPending, TCommand>;
  readonly maxMemoryEntries: number;
  private mutableState: AgentScaffoldState<TObservation, TPending, TCommand>;
  private latestObservationContext?: SocialActorObservationContext<TPending>;
  private readonly seenMessageIds = new Set<string>();

  constructor(options: ScaffoldedActorOptions<TObservation, TPending, TCommand>) {
    this.id = options.id;
    this.profile = cloneJson(options.profile);
    this.policy = options.policy;
    this.reasoner = options.reasoner;
    this.candidateScorers = [...(options.candidateScorers ?? [])];
    this.actionArbitrator = options.actionArbitrator;
    this.maxMemoryEntries = options.maxMemoryEntries ?? 200;
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
    };
    hydrateSeenSocialMessageIds(this.mutableState.social, this.seenMessageIds);
  }

  get state(): AgentScaffoldState<TObservation, TPending, TCommand> {
    return cloneJson(this.mutableState);
  }

  observe(observation: TObservation, context?: SocialActorObservationContext<TPending>): void {
    this.latestObservationContext = cloneJson(context);
    this.mutableState.observations += 1;
    this.mutableState.lastObservation = cloneJson(observation);
    this.remember({
      kind: "observation",
      observation: cloneJson(observation),
      source: "observation",
      visibility: "private",
      evidenceRefs: [{ artifact: "observation", seq: this.mutableState.observations }]
    }, scaffoldMutationContext(context));
    const visibleMessages = extractVisibleSocialMessagesFromObservation(observation);
    if (visibleMessages.length) {
      ingestVisibleSocialMessages({
        social: this.mutableState.social,
        observerId: this.id,
        messages: visibleMessages,
        seenMessageIds: this.seenMessageIds,
        context: scaffoldMutationContext(context)
      });
      this.syncCompatibilityMemory();
    }
  }

  async decide(pending: TPending): Promise<SocialAction<TCommand>> {
    if (this.mutableState.lastObservation === undefined) {
      throw new Error(`Scaffolded actor ${this.id} cannot decide before observe().`);
    }
    const observation = this.mutableState.lastObservation;
    const memo = await this.reasoner?.reflect(this.decisionInput(observation, pending));
    if (memo) {
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
      }, scaffoldMutationContext(this.latestObservationContext));
    }
    const input = this.decisionInput(observation, pending);
    const { action, arbitration } = await this.selectAction(input, memo);
    if (action.actorId !== this.id) {
      throw new Error(`Policy ${this.policy.id} returned action for ${action.actorId}, expected ${this.id}.`);
    }
    const actionWithArbitration = arbitration ? withArbitrationMetadata(action, arbitration) : action;
    this.mutableState.decisions += 1;
    this.mutableState.lastAction = cloneJson(actionWithArbitration);
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
            arbitration
          }
        : {
            policyId: this.policy.id
          }
    }, scaffoldMutationContext(this.latestObservationContext));
    return cloneJson(actionWithArbitration);
  }

  private async selectAction(
    input: AgentDecisionInput<TObservation, TPending, TCommand>,
    reasonerMemo?: string
  ): Promise<{ action: SocialAction<TCommand>; arbitration?: AgentActionArbitrationSummary }> {
    const generated = this.policy.generateCandidates?.(cloneJson(input));
    if (!generated && !this.actionArbitrator && !this.candidateScorers.length) {
      return { action: this.policy.decide(input) };
    }
    const candidates = generated ?? [candidateFromPolicyAction(this.id, this.policy.id, this.policy.decide(input))];
    const normalized = await this.scoreCandidates(normalizeCandidates(this.id, candidates), input, reasonerMemo);
    const decision = this.actionArbitrator
      ? await this.actionArbitrator.arbitrate({
          ...this.decisionInput(input.observation, input.pendingAction),
          policyId: this.policy.id,
          reasonerMemo,
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
    input: AgentDecisionInput<TObservation, TPending, TCommand>,
    reasonerMemo?: string
  ): Promise<Array<AgentActionCandidate<TCommand>>> {
    if (!this.candidateScorers.length) return candidates;
    const scored: Array<AgentActionCandidate<TCommand>> = [];
    for (const candidate of candidates) {
      let next = cloneJson(candidate);
      for (const scorer of this.candidateScorers) {
        const contribution = await scorer.score({
          ...this.decisionInput(input.observation, input.pendingAction),
          policyId: this.policy.id,
          reasonerMemo,
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

  private decisionInput(observation: TObservation, pending: TPending): AgentDecisionInput<TObservation, TPending, TCommand> {
    return {
      agent: this.state,
      observation: cloneJson(observation),
      pendingAction: cloneJson(pending)
    };
  }

  private remember(
    entry: Omit<ScaffoldMemoryEntry<TObservation, TPending, TCommand>, "seq" | "createdAt">,
    context?: SocialStateMutationContext
  ): void {
    appendSocialMemory(this.mutableState.social, {
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
    this.mutableState.memory = this.mutableState.social.memory.entries.map((memoryEntry) => ({
      seq: memoryEntry.seq,
      kind: memoryEntry.kind === "observation" || memoryEntry.kind === "decision" || memoryEntry.kind === "memo" ? memoryEntry.kind : "memo",
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
}

export function createScaffoldedActor<TObservation, TPending, TCommand>(
  options: ScaffoldedActorOptions<TObservation, TPending, TCommand>
): ScaffoldedSocialActor<TObservation, TPending, TCommand> {
  return new ScaffoldedSocialActor(options);
}

export function createDefaultAgentActionCandidateScorerRegistry<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown
>(): AgentActionCandidateScorerRegistry<TObservation, TPending, TCommand> {
  return {
    [WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND]: (config) =>
      createWeightedSocialStateCandidateScorer<TObservation, TPending, TCommand>(
        normalizeWeightedSocialStateCandidateScorerOptions(config.options, `${config.kind}.options`)
      )
  };
}

export function resolveAgentActionCandidateScorers<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown
>(
  configs: readonly unknown[] = [],
  registry: AgentActionCandidateScorerRegistry<TObservation, TPending, TCommand> = createDefaultAgentActionCandidateScorerRegistry<
    TObservation,
    TPending,
    TCommand
  >()
): Array<AgentActionCandidateScorer<TObservation, TPending, TCommand>> {
  return configs.map((value, index) => {
    const config = normalizeAgentActionCandidateScorerConfig(value, index);
    const factory = registry[config.kind];
    if (!factory) {
      throw new Error(`Unknown candidate scorer kind ${config.kind}. Registered scorers: ${Object.keys(registry).sort().join(", ") || "none"}.`);
    }
    return factory(config);
  });
}

export function createWeightedSocialStateCandidateScorer<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown
>(
  options: WeightedSocialStateCandidateScorerOptions = {}
): AgentActionCandidateScorer<TObservation, TPending, TCommand> {
  const scorerId = options.id ?? "weighted-social-state-candidate-scorer";
  return {
    id: scorerId,
    score(input) {
      const targetIds = input.candidate.socialTargetIds ?? [];
      if (!targetIds.length) return undefined;
      const reasons: string[] = [];
      const evidenceRefs: EvidenceRef[] = [];
      let delta = 0;
      for (const targetId of targetIds) {
        const relationship = input.agent.social.relationships.edges[targetId];
        if (relationship) {
          const contribution = weightedRelationshipContribution(relationship, options.relationshipWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...relationship.evidenceRefs);
        }
        const reputation = input.agent.social.reputation.records[targetId];
        if (reputation) {
          const contribution = weightedReputationContribution(reputation, options.reputationWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...reputation.evidenceRefs);
        }
        for (const claim of Object.values(input.agent.social.beliefs.claims).filter((item) => item.subject === targetId)) {
          const contribution = weightedBeliefContribution(claim, options.beliefPredicateWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...claim.evidenceRefs);
        }
        if (options.activeGoalWeight) {
          for (const goal of input.agent.social.goals.goals.filter((item) => item.status === "active" && socialRecordTargets(item, targetId))) {
            delta += goal.priority * options.activeGoalWeight;
            reasons.push(`goal:${goal.kind}`);
            evidenceRefs.push(...goal.evidenceRefs);
          }
        }
        if (options.activeNormWeight) {
          for (const norm of Object.values(input.agent.social.norms.norms).filter((item) => item.status === "active" && socialRecordTargets(item, targetId))) {
            delta += norm.confidence * options.activeNormWeight;
            reasons.push(`norm:${norm.kind}`);
            evidenceRefs.push(...norm.evidenceRefs);
          }
        }
        for (const commitment of Object.values(input.agent.social.commitments?.records ?? {}).filter((item) =>
          commitmentTargets(item, targetId)
        )) {
          const contribution = weightedCommitmentContribution(commitment, options.commitmentStatusWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...commitment.evidenceRefs);
        }
        for (const coalition of Object.values(input.agent.social.coalitions?.records ?? {}).filter((item) =>
          coalitionTargets(item, targetId)
        )) {
          const contribution = weightedCoalitionContribution(coalition, options.coalitionStatusWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...coalition.evidenceRefs);
        }
        for (const gossip of Object.values(input.agent.social.gossip?.records ?? {}).filter((item) => gossipTargets(item, targetId))) {
          const contribution = weightedGossipContribution(gossip, options.gossipValenceWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...gossip.evidenceRefs);
        }
        for (const sanction of Object.values(input.agent.social.normSanctions?.records ?? {}).filter((item) =>
          normSanctionTargets(item, targetId)
        )) {
          const contribution = weightedNormSanctionContribution(sanction, {
            kindWeights: options.normSanctionKindWeights ?? {},
            statusWeights: options.normSanctionStatusWeights ?? {}
          });
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...sanction.evidenceRefs);
        }
        for (const repair of Object.values(input.agent.social.trustRepairs?.records ?? {}).filter((item) =>
          trustRepairTargets(item, targetId)
        )) {
          const contribution = weightedTrustRepairContribution(repair, {
            kindWeights: options.trustRepairKindWeights ?? {},
            statusWeights: options.trustRepairStatusWeights ?? {}
          });
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...repair.evidenceRefs);
        }
        for (const betrayal of Object.values(input.agent.social.betrayals?.records ?? {}).filter((item) =>
          betrayalTargets(item, targetId)
        )) {
          const contribution = weightedBetrayalContribution(betrayal, {
            kindWeights: options.betrayalKindWeights ?? {},
            statusWeights: options.betrayalStatusWeights ?? {}
          });
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...betrayal.evidenceRefs);
        }
      }
      const uniqueEvidenceRefs = uniqueEvidence(evidenceRefs);
      if (!uniqueEvidenceRefs.length || delta === 0) return undefined;
      return {
        scorerId,
        source: "social_state",
        socialScoreDelta: round3(delta),
        finalScoreDelta: round3(delta),
        reasons: uniqueStrings(reasons),
        evidenceRefs: uniqueEvidenceRefs
      };
    }
  };
}

function candidateFromPolicyAction<TCommand>(actorId: string, policyId: string, action: SocialAction<TCommand>): AgentActionCandidate<TCommand> {
  return {
    id: `${policyId}:selected`,
    actorId,
    kind: action.kind,
    source: "policy",
    action: cloneJson(action),
    reasons: ["legacy policy decision"],
    evidenceRefs: [{ artifact: "action", description: `policy:${policyId}` }]
  };
}

function normalizeCandidates<TCommand>(actorId: string, candidates: Array<AgentActionCandidate<TCommand>>): Array<AgentActionCandidate<TCommand>> {
  if (!candidates.length) throw new Error(`Action arbitration for ${actorId} requires at least one candidate.`);
  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    if (!candidate.id) throw new Error(`Action arbitration candidate at index ${index} is missing an id.`);
    if (seen.has(candidate.id)) throw new Error(`Action arbitration candidate id ${candidate.id} is duplicated.`);
    seen.add(candidate.id);
    if (candidate.actorId !== actorId) {
      throw new Error(`Action arbitration candidate ${candidate.id} belongs to ${candidate.actorId}, expected ${actorId}.`);
    }
    if (candidate.action.actorId !== actorId) {
      throw new Error(`Action arbitration candidate ${candidate.id} action belongs to ${candidate.action.actorId}, expected ${actorId}.`);
    }
    if (candidate.action.kind !== candidate.kind) {
      throw new Error(`Action arbitration candidate ${candidate.id} kind ${candidate.kind} does not match action kind ${candidate.action.kind}.`);
    }
    if (!candidate.evidenceRefs?.length) {
      throw new Error(`Action arbitration candidate ${candidate.id} must include evidence refs.`);
    }
    return {
      ...cloneJson(candidate),
      socialTargetIds: candidate.socialTargetIds ? uniqueStrings(candidate.socialTargetIds) : undefined,
      scoreContributions: cloneJson(candidate.scoreContributions),
      reasons: cloneJson(candidate.reasons ?? []),
      evidenceRefs: cloneJson(candidate.evidenceRefs ?? [])
    };
  });
}

function normalizeScoreContribution(scorerId: string, contribution: AgentActionCandidateScoreContribution): AgentActionCandidateScoreContribution {
  const evidenceRefs = uniqueEvidence(contribution.evidenceRefs ?? []);
  if (!evidenceRefs.length) {
    throw new Error(`Candidate scorer ${scorerId} contribution requires at least one evidence ref.`);
  }
  return {
    scorerId,
    source: contribution.source,
    utilityScoreDelta: finiteNumber(contribution.utilityScoreDelta),
    socialScoreDelta: finiteNumber(contribution.socialScoreDelta),
    riskPenaltyDelta: finiteNumber(contribution.riskPenaltyDelta),
    legalityScoreDelta: finiteNumber(contribution.legalityScoreDelta),
    finalScoreDelta: finiteNumber(contribution.finalScoreDelta),
    reasons: uniqueStrings(contribution.reasons ?? []),
    evidenceRefs
  };
}

function applyScoreContribution<TCommand>(
  candidate: AgentActionCandidate<TCommand>,
  contribution: AgentActionCandidateScoreContribution
): AgentActionCandidate<TCommand> {
  const utilityDelta = contribution.utilityScoreDelta ?? 0;
  const socialDelta = contribution.socialScoreDelta ?? 0;
  const riskDelta = contribution.riskPenaltyDelta ?? 0;
  const legalityDelta = contribution.legalityScoreDelta ?? 0;
  const finalDelta = contribution.finalScoreDelta ?? utilityDelta + socialDelta + legalityDelta - riskDelta;
  return {
    ...cloneJson(candidate),
    utilityScore: addScore(candidate.utilityScore, utilityDelta),
    socialScore: addScore(candidate.socialScore, socialDelta),
    riskPenalty: addScore(candidate.riskPenalty, riskDelta),
    legalityScore: addScore(candidate.legalityScore, legalityDelta),
    finalScore: addScore(candidate.finalScore, finalDelta),
    scoreContributions: [...(candidate.scoreContributions ?? []), cloneJson(contribution)],
    reasons: uniqueStrings([...(candidate.reasons ?? []), ...contribution.reasons]),
    evidenceRefs: uniqueEvidence([...(candidate.evidenceRefs ?? []), ...contribution.evidenceRefs])
  };
}

function defaultActionArbitrationDecision<TCommand>(candidates: Array<AgentActionCandidate<TCommand>>): AgentActionArbitrationDecision {
  const sorted = [...candidates].sort((left, right) => {
    const leftScore = numericScore(left.finalScore);
    const rightScore = numericScore(right.finalScore);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.id.localeCompare(right.id);
  });
  return {
    selectedCandidateId: sorted[0].id,
    decisionRule: "highest_final_score_then_candidate_id"
  };
}

function buildArbitrationSummary<TCommand>(options: {
  actorId: string;
  policyId: string;
  arbitratorId: string;
  decision: AgentActionArbitrationDecision;
  candidates: Array<AgentActionCandidate<TCommand>>;
}): AgentActionArbitrationSummary {
  return {
    version: "agent.action-arbitration.v1",
    actorId: options.actorId,
    policyId: options.policyId,
    arbitratorId: options.arbitratorId,
    selectedCandidateId: options.decision.selectedCandidateId,
    candidateCount: options.candidates.length,
    decisionRule: options.decision.decisionRule ?? "custom_selected_candidate_id",
    selectionReason: options.decision.reason,
    selectionEvidenceRefs: cloneJson(options.decision.evidenceRefs),
    candidates: options.candidates.map(candidateSummary)
  };
}

function candidateSummary<TCommand>(candidate: AgentActionCandidate<TCommand>): AgentActionCandidateSummary {
  return {
    id: candidate.id,
    actorId: candidate.actorId,
    kind: candidate.kind,
    source: candidate.source,
    socialTargetIds: cloneJson(candidate.socialTargetIds),
    baseScore: finiteNumber(candidate.baseScore),
    utilityScore: finiteNumber(candidate.utilityScore),
    socialScore: finiteNumber(candidate.socialScore),
    riskPenalty: finiteNumber(candidate.riskPenalty),
    legalityScore: finiteNumber(candidate.legalityScore),
    finalScore: finiteNumber(candidate.finalScore),
    scoreContributions: cloneJson(candidate.scoreContributions),
    reasons: cloneJson(candidate.reasons),
    evidenceRefs: cloneJson(candidate.evidenceRefs),
    messageCount: candidate.action.messages?.length ?? 0
  };
}

function withArbitrationMetadata<TCommand>(
  action: SocialAction<TCommand>,
  arbitration: AgentActionArbitrationSummary
): SocialAction<TCommand> {
  return {
    ...cloneJson(action),
    metadata: {
      ...(cloneJson(action.metadata) ?? {}),
      arbitration: cloneJson(arbitration)
    }
  };
}

function numericScore(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addScore(value: number | undefined, delta: number): number | undefined {
  if (delta === 0 && value === undefined) return undefined;
  return round3(numericScore(value) + delta);
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function weightedRelationshipContribution(
  relationship: RelationshipEdge,
  weights: Partial<Record<AgentRelationshipScoreField, number>>
): { delta: number; reasons: string[] } {
  const fields: AgentRelationshipScoreField[] = ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"];
  return weightedNumericContribution(relationship, fields, weights, "relationship");
}

function weightedReputationContribution(
  reputation: ReputationRecord,
  weights: Partial<Record<AgentReputationScoreField, number>>
): { delta: number; reasons: string[] } {
  const fields: AgentReputationScoreField[] = ["honesty", "competence", "cooperation", "threat", "normCompliance"];
  return weightedNumericContribution(reputation, fields, weights, "reputation");
}

function weightedNumericContribution<TField extends string>(
  record: Record<TField, number>,
  fields: TField[],
  weights: Partial<Record<TField, number>>,
  reasonPrefix: string
): { delta: number; reasons: string[] } {
  let delta = 0;
  const reasons: string[] = [];
  for (const field of fields) {
    const weight = weights[field];
    const value = record[field];
    if (typeof weight !== "number" || !Number.isFinite(weight) || value === 0) continue;
    const contribution = value * weight;
    if (contribution === 0) continue;
    delta += contribution;
    reasons.push(`${reasonPrefix}:${field}`);
  }
  return { delta: round3(delta), reasons };
}

function weightedBeliefContribution(claim: BeliefClaim, weights: Record<string, number>): { delta: number; reasons: string[] } {
  const weight = weights[claim.predicate];
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { delta: 0, reasons: [] };
  const valueScore = beliefValueScore(claim.value);
  if (valueScore === undefined) return { delta: 0, reasons: [] };
  const delta = round3(valueScore * claim.confidence * weight);
  return delta === 0 ? { delta: 0, reasons: [] } : { delta, reasons: [`belief:${claim.predicate}`] };
}

function beliefValueScore(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : -1;
  return undefined;
}

function weightedCommitmentContribution(
  commitment: CommitmentRecord,
  statusWeights: Partial<Record<CommitmentStatus, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(commitment.status, commitment.confidence, statusWeights, "commitment");
}

function weightedCoalitionContribution(
  coalition: CoalitionRecord,
  statusWeights: Partial<Record<CoalitionStatus, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(coalition.status, coalition.confidence, statusWeights, "coalition");
}

function weightedGossipContribution(
  gossip: GossipRecord,
  valenceWeights: Partial<Record<GossipValence, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(gossip.valence, gossip.confidence, valenceWeights, "gossip");
}

function weightedNormSanctionContribution(
  sanction: NormSanctionRecord,
  options: {
    kindWeights: Partial<Record<NormSanctionKind, number>>;
    statusWeights: Partial<Record<NormSanctionStatus, number>>;
  }
): { delta: number; reasons: string[] } {
  return combineContributions([
    weightedCategoricalContribution(sanction.kind, sanction.confidence, options.kindWeights, "normSanction"),
    weightedCategoricalContribution(sanction.status, sanction.confidence, options.statusWeights, "normSanction")
  ]);
}

function weightedTrustRepairContribution(
  repair: TrustRepairRecord,
  options: {
    kindWeights: Partial<Record<TrustRepairKind, number>>;
    statusWeights: Partial<Record<TrustRepairStatus, number>>;
  }
): { delta: number; reasons: string[] } {
  return combineContributions([
    weightedCategoricalContribution(repair.kind, repair.confidence, options.kindWeights, "trustRepair"),
    weightedCategoricalContribution(repair.status, repair.confidence, options.statusWeights, "trustRepair")
  ]);
}

function weightedBetrayalContribution(
  betrayal: BetrayalRecord,
  options: {
    kindWeights: Partial<Record<BetrayalKind, number>>;
    statusWeights: Partial<Record<BetrayalStatus, number>>;
  }
): { delta: number; reasons: string[] } {
  return combineContributions([
    weightedCategoricalContribution(betrayal.kind, betrayal.confidence, options.kindWeights, "betrayal"),
    weightedCategoricalContribution(betrayal.status, betrayal.confidence, options.statusWeights, "betrayal")
  ]);
}

function normalizeAgentActionCandidateScorerConfig(value: unknown, index: number): AgentActionCandidateScorerConfig {
  if (!isRecord(value)) {
    throw new Error(`Candidate scorer config at index ${index} must be an object.`);
  }
  const kind = nonEmptyString(value.kind);
  if (!kind) {
    throw new Error(`Candidate scorer config at index ${index} requires a non-empty kind.`);
  }
  const allowedKeys = new Set(["kind", "options"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Candidate scorer config ${kind}.${key} is not supported.`);
  }
  return {
    kind,
    options: cloneJson(value.options)
  };
}

function normalizeWeightedSocialStateCandidateScorerOptions(
  value: unknown,
  path: string
): WeightedSocialStateCandidateScorerOptions {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  assertOnlyKeys(value, path, [
    "id",
    "relationshipWeights",
    "reputationWeights",
    "beliefPredicateWeights",
    "activeGoalWeight",
    "activeNormWeight",
    "commitmentStatusWeights",
    "coalitionStatusWeights",
    "gossipValenceWeights",
    "normSanctionKindWeights",
    "normSanctionStatusWeights",
    "trustRepairKindWeights",
    "trustRepairStatusWeights",
    "betrayalKindWeights",
    "betrayalStatusWeights"
  ]);
  return {
    id: optionalStringOption(value.id, `${path}.id`),
    relationshipWeights: normalizeWeightMap(value.relationshipWeights, RELATIONSHIP_SCORE_FIELDS, `${path}.relationshipWeights`),
    reputationWeights: normalizeWeightMap(value.reputationWeights, REPUTATION_SCORE_FIELDS, `${path}.reputationWeights`),
    beliefPredicateWeights: normalizeOpenWeightMap(value.beliefPredicateWeights, `${path}.beliefPredicateWeights`),
    activeGoalWeight: optionalNumberOption(value.activeGoalWeight, `${path}.activeGoalWeight`),
    activeNormWeight: optionalNumberOption(value.activeNormWeight, `${path}.activeNormWeight`),
    commitmentStatusWeights: normalizeWeightMap(value.commitmentStatusWeights, COMMITMENT_STATUSES, `${path}.commitmentStatusWeights`),
    coalitionStatusWeights: normalizeWeightMap(value.coalitionStatusWeights, COALITION_STATUSES, `${path}.coalitionStatusWeights`),
    gossipValenceWeights: normalizeWeightMap(value.gossipValenceWeights, GOSSIP_VALENCES, `${path}.gossipValenceWeights`),
    normSanctionKindWeights: normalizeWeightMap(value.normSanctionKindWeights, NORM_SANCTION_KINDS, `${path}.normSanctionKindWeights`),
    normSanctionStatusWeights: normalizeWeightMap(value.normSanctionStatusWeights, NORM_SANCTION_STATUSES, `${path}.normSanctionStatusWeights`),
    trustRepairKindWeights: normalizeWeightMap(value.trustRepairKindWeights, TRUST_REPAIR_KINDS, `${path}.trustRepairKindWeights`),
    trustRepairStatusWeights: normalizeWeightMap(value.trustRepairStatusWeights, TRUST_REPAIR_STATUSES, `${path}.trustRepairStatusWeights`),
    betrayalKindWeights: normalizeWeightMap(value.betrayalKindWeights, BETRAYAL_KINDS, `${path}.betrayalKindWeights`),
    betrayalStatusWeights: normalizeWeightMap(value.betrayalStatusWeights, BETRAYAL_STATUSES, `${path}.betrayalStatusWeights`)
  };
}

function normalizeWeightMap<TValue extends string>(
  value: unknown,
  allowedKeys: readonly TValue[],
  path: string
): Partial<Record<TValue, number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const output: Partial<Record<TValue, number>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowedKeys.includes(key as TValue)) {
      throw new Error(`${path}.${key} is not supported. Valid keys: ${allowedKeys.join(", ")}.`);
    }
    output[key as TValue] = numberOption(entry, `${path}.${key}`);
  }
  return output;
}

function normalizeOpenWeightMap(value: unknown, path: string): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`${path} keys must be non-empty strings.`);
    output[key] = numberOption(entry, `${path}.${key}`);
  }
  return output;
}

function optionalStringOption(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${path} must be a non-empty string.`);
  return normalized;
}

function optionalNumberOption(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return numberOption(value, path);
}

function numberOption(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, path: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function weightedCategoricalContribution<TValue extends string>(
  value: TValue,
  confidence: number,
  weights: Partial<Record<TValue, number>>,
  reasonPrefix: string
): { delta: number; reasons: string[] } {
  const weight = weights[value];
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { delta: 0, reasons: [] };
  const delta = round3(confidence * weight);
  return delta === 0 ? { delta: 0, reasons: [] } : { delta, reasons: [`${reasonPrefix}:${value}`] };
}

function combineContributions(contributions: Array<{ delta: number; reasons: string[] }>): { delta: number; reasons: string[] } {
  return {
    delta: round3(contributions.reduce((sum, contribution) => sum + contribution.delta, 0)),
    reasons: uniqueStrings(contributions.flatMap((contribution) => contribution.reasons))
  };
}

function socialRecordTargets(record: GoalRecord | NormRecord, targetId: string): boolean {
  const metadata = record.metadata;
  return metadataTargets(metadata, targetId);
}

function commitmentTargets(record: CommitmentRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function coalitionTargets(record: CoalitionRecord, targetId: string): boolean {
  return record.targetId === targetId || record.memberIds.includes(targetId) || metadataTargets(record.metadata, targetId);
}

function gossipTargets(record: GossipRecord, targetId: string): boolean {
  return record.subjectId === targetId || metadataTargets(record.metadata, targetId);
}

function normSanctionTargets(record: NormSanctionRecord, targetId: string): boolean {
  return record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function trustRepairTargets(record: TrustRepairRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function betrayalTargets(record: BetrayalRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function metadataTargets(metadata: Record<string, unknown> | undefined, targetId: string): boolean {
  if (!metadata) return false;
  if (metadata.targetId === targetId) return true;
  return Array.isArray(metadata.targetIds) && metadata.targetIds.some((item) => item === targetId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RELATIONSHIP_SCORE_FIELDS: readonly AgentRelationshipScoreField[] = ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"];
const REPUTATION_SCORE_FIELDS: readonly AgentReputationScoreField[] = ["honesty", "competence", "cooperation", "threat", "normCompliance"];
const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ["active", "fulfilled", "broken", "unknown", "expired", "withdrawn"];
const COALITION_STATUSES: readonly CoalitionStatus[] = ["forming", "active", "fulfilled", "dissolved", "betrayed", "unknown"];
const GOSSIP_VALENCES: readonly GossipValence[] = ["positive", "negative", "neutral", "mixed", "unknown"];
const NORM_SANCTION_KINDS: readonly NormSanctionKind[] = ["warning", "pressure", "reputation", "exclusion", "punishment", "repair_request", "reward"];
const NORM_SANCTION_STATUSES: readonly NormSanctionStatus[] = ["proposed", "applied", "repaired", "withdrawn", "expired", "unknown"];
const TRUST_REPAIR_KINDS: readonly TrustRepairKind[] = [
  "apology",
  "explanation",
  "evidence_provided",
  "correction",
  "commitment_made",
  "compensation",
  "public_clarification",
  "coalition_repair",
  "norm_repair",
  "reputation_repair",
  "other"
];
const TRUST_REPAIR_STATUSES: readonly TrustRepairStatus[] = [
  "proposed",
  "attempted",
  "accepted",
  "rejected",
  "in_progress",
  "completed",
  "failed",
  "withdrawn",
  "expired",
  "unknown"
];
const BETRAYAL_KINDS: readonly BetrayalKind[] = [
  "commitment_broken",
  "coalition_betrayal",
  "information_leak",
  "vote_flip",
  "attack",
  "abandonment",
  "deception",
  "other"
];
const BETRAYAL_STATUSES: readonly BetrayalStatus[] = ["alleged", "acknowledged", "contested", "confirmed", "repaired", "withdrawn", "unknown"];

function uniqueEvidence(evidenceRefs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of evidenceRefs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cloneJson(ref));
  }
  return unique;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function scaffoldMutationContext<TPending>(context?: SocialActorObservationContext<TPending>): SocialStateMutationContext | undefined {
  if (!context) return undefined;
  return {
    traceId: context.traceId,
    turnIndex: context.actorTurnIndex ?? context.turnIndex,
    phase: stringField(context.pendingAction, "phase"),
    day: numberField(context.pendingAction, "day")
  };
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}
