import { metric, type HarnessEvaluator, type HarnessEvaluationContext } from "./evaluation";
import { deriveSocialExposureRecords, type SocialEpisodeArtifact, type SocialExposureRecord, type SocialMessage, type SocialSpeechAct } from "./social";
import type {
  HarnessEvaluatorManifestConfig,
  HarnessEvaluationModuleResult,
  HarnessMetricEvidenceRef,
  HarnessMetricRecord
} from "./types";
import type {
  BetrayalRecord,
  AgentSocialState,
  CoalitionRecord,
  CommitmentRecord,
  EvidenceRef,
  GossipRecord,
  NormSanctionRecord,
  NormRecord,
  RelationshipEdge,
  ReputationRecord,
  SocialMemoryEntry,
  SocialStateMutationJournalEntry,
  TrustRepairRecord
} from "./socialState";

/**
 * Minimal durable actor projection required by the generic social evaluators.
 * New domain adapters should provide `id`; legacy artifacts can derive their
 * identity from `social.agentId` until their snapshot schema is migrated.
 */
export interface SocialAgentSnapshot {
  id?: string;
  profileId?: string;
  model?: string;
  policyId?: string;
  social?: AgentSocialState;
  socialStateHash?: string;
}

interface LegacySocialAgentProjection {
  playerId?: string;
  policyName?: string;
}

type SocialEvaluationContext<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown> = HarnessEvaluationContext<
  TState,
  TMetrics,
  TSocialEpisode,
  SocialAgentSnapshot,
  unknown
>;

type SocialEvaluator<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown, TOutput = unknown> = HarnessEvaluator<
  TState,
  TMetrics,
  TSocialEpisode,
  TOutput,
  SocialAgentSnapshot,
  unknown
>;

export const SOCIAL_STATE_EVALUATOR_ID = "social.state.v1";
export const SOCIAL_STATE_METRIC_IDS = [
  "agent.social.memory_count",
  "agent.social.evidenced_memory_rate",
  "agent.social.journal_entry_count",
  "agent.social.evidenced_journal_rate",
  "agent.social.journal_store_coverage_count",
  "agent.social.belief_count",
  "agent.social.evidenced_belief_rate",
  "agent.social.avg_belief_confidence",
  "agent.social.relationship_edge_count",
  "agent.social.avg_trust",
  "agent.social.avg_suspicion",
  "agent.social.avg_influence",
  "agent.social.reputation_record_count",
  "agent.social.avg_reputation_honesty",
  "agent.social.avg_reputation_cooperation",
  "agent.social.avg_reputation_threat",
  "agent.social.avg_norm_compliance",
  "agent.social.norm_count",
  "agent.social.violated_norm_count",
  "agent.social.fulfilled_norm_count",
  "agent.social.goal_count",
  "agent.social.active_goal_count",
  "agent.social.completed_goal_count",
  "agent.social.commitment_count",
  "agent.social.active_commitment_count",
  "agent.social.fulfilled_commitment_count",
  "agent.social.broken_commitment_count",
  "agent.social.evidenced_commitment_rate",
  "agent.social.coalition_count",
  "agent.social.active_coalition_count",
  "agent.social.betrayed_coalition_count",
  "agent.social.evidenced_coalition_rate",
  "agent.social.gossip_count",
  "agent.social.evidenced_gossip_rate",
  "agent.social.norm_sanction_count",
  "agent.social.applied_norm_sanction_count",
  "agent.social.evidenced_norm_sanction_rate",
  "agent.social.trust_repair_count",
  "agent.social.accepted_trust_repair_count",
  "agent.social.evidenced_trust_repair_rate",
  "agent.social.betrayal_count",
  "agent.social.confirmed_betrayal_count",
  "agent.social.evidenced_betrayal_rate"
];
export const SOCIAL_STATE_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.social-state.evaluation-context.v1",
  outputSchema: "harness.social-state.summary.v1",
  mode: "deterministic",
  metricIds: SOCIAL_STATE_METRIC_IDS,
  rubric:
    "Deterministically audits serialized agent social state after an episode, including memory, beliefs, relationships, reputation, norms, goals, commitments, coalitions, gossip, norm sanctions, trust repairs, betrayals, and evidence-backed rates. These are record and coverage metrics only; they do not assert betrayal truth, causality, persuasion/deception success, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {},
  aggregation: "agent_social_state_summary",
  visibility: "postgame"
};
export const SOCIAL_DYNAMICS_EVALUATOR_ID = "social.dynamics.v1";
export const SOCIAL_DYNAMICS_METRIC_IDS = [
  "agent.social.influence_edge_count",
  "agent.social.coordination_message_count",
  "agent.social.coalition_signal_count",
  "agent.social.exposure_received_count",
  "agent.social.public_exposure_received_count",
  "agent.social.unique_exposure_source_count",
  "agent.social.reputation_evidence_rate",
  "agent.social.norm_pressure_count",
  "agent.social.norm_resolution_rate"
];
export const SOCIAL_DYNAMICS_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.social-dynamics.evaluation-context.v1",
  outputSchema: "harness.social-dynamics.summary.v1",
  mode: "deterministic",
  metricIds: SOCIAL_DYNAMICS_METRIC_IDS,
  rubric:
    "Deterministically audits social interaction signals from serialized agent social state and scoped observation artifacts, including influence edges, coordination messages, coalition signals, message exposure, reputation evidence, and norm pressure.",
  dependencies: {},
  aggregation: "agent_social_dynamics_summary",
  visibility: "postgame"
};
export const SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID = "evaluation.social-fact-ingest-evidence.v1";
export const SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS = [
  "agent.social.commitment_speech_act_ingest_link_count",
  "agent.social.commitment_speech_act_ingest_link_rate",
  "agent.social.coalition_speech_act_ingest_link_count",
  "agent.social.coalition_speech_act_ingest_link_rate",
  "agent.social.relationship_fact_ingest_link_count",
  "agent.social.relationship_fact_ingest_link_rate",
  "agent.social.reputation_fact_ingest_link_count",
  "agent.social.reputation_fact_ingest_link_rate"
];
export const SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.social-fact-ingest-evidence.evaluation-context.v1",
  outputSchema: "harness.social-fact-ingest-evidence.summary.v1",
  mode: "deterministic",
  metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
  rubric:
    "Deterministically audits zero-weight coverage links from explicit top-level commitment/coalition speech acts or structured relationship/reputation metadata.socialFacts, through actor-scoped exposure, to evidence-backed social-state journal mutations. This is an ingest evidence coverage diagnostic only; it does not parse free text, infer hidden exposure, assert causality, persuasion success, deception success, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {
    socialEpisode: "SocialEpisodeArtifact.messages and scoped SocialExposureRecord records from actor observations",
    mutationJournal:
      "AgentSocialState.journal.entries with store/mutationKind, messageSeqRange, safe provenance metadata, hiddenTruthUsed=false, and evidenceRefs",
    socialState: "AgentSocialState commitments, coalitions, relationships, and reputation records for mutation evidence"
  },
  aggregation: "zero_weight_social_fact_ingest_evidence_by_agent",
  visibility: "postgame"
};
export const COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID = "evaluation.commitment-coalition-association.v1";
export const COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS = [
  "agent.social.commitment_coalition_association_count",
  "agent.social.commitment_coalition_association_rate",
  "agent.social.commitment_coalition_evaluable_pair_rate"
];
export const COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.commitment-coalition-association.evaluation-context.v1",
  outputSchema: "harness.commitment-coalition-association.summary.v1",
  mode: "deterministic",
  metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits explicit evidence or metadata association between commitment and coalition records. This is a zero-weight association baseline and does not assert causality, effectiveness, reward impact, or counterfactual influence.",
  dependencies: {
    socialState: "AgentSocialState.commitments, AgentSocialState.coalitions, and evidence-backed social-state records"
  },
  aggregation: "zero_weight_commitment_coalition_association_by_agent",
  visibility: "postgame"
};
export const COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.commitment-coalition-lifecycle-temporal-association.v1";
export const COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.commitment_status_temporal_association_count",
  "agent.social.commitment_status_temporal_association_rate",
  "agent.social.commitment_status_temporal_evaluable_record_rate",
  "agent.social.coalition_lifecycle_temporal_association_count",
  "agent.social.coalition_lifecycle_temporal_association_rate",
  "agent.social.coalition_lifecycle_temporal_evaluable_record_rate"
];
export const COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.commitment-coalition-lifecycle-temporal-association.evaluation-context.v1",
  outputSchema: "harness.commitment-coalition-lifecycle-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits ordered mutation-journal lifecycle associations for commitments and coalitions using a strict turnIndex-after-creation ordering rule. It only compares explicit commitment.added to later commitment.status.updated and coalition.added to later coalition.evidence.recorded entries with whitelisted lifecycle evidence kinds. This is a zero-weight temporal association baseline and does not assert causality, effectiveness, reward impact, or counterfactual influence.",
  dependencies: {
    mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
    socialState: "AgentSocialState.commitments and AgentSocialState.coalitions for record denominators"
  },
  aggregation: "zero_weight_commitment_coalition_lifecycle_temporal_association_by_agent",
  visibility: "postgame"
};
export const NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.norm-sanction-lifecycle-temporal-association.v1";
export const NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.norm_status_temporal_association_count",
  "agent.social.norm_status_temporal_association_rate",
  "agent.social.norm_status_temporal_evaluable_record_rate",
  "agent.social.norm_sanction_status_temporal_association_count",
  "agent.social.norm_sanction_status_temporal_association_rate",
  "agent.social.norm_sanction_status_temporal_evaluable_record_rate"
];
export const NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.norm-sanction-lifecycle-temporal-association.evaluation-context.v1",
  outputSchema: "harness.norm-sanction-lifecycle-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits ordered mutation-journal lifecycle associations for norms and norm sanctions using a strict turnIndex-after-creation ordering rule. It only compares explicit norm.added to later norm.status.updated and norm_sanction.added to later norm_sanction.status.updated entries. This is a zero-weight temporal association baseline and does not assert causality, compliance effects, reward impact, or counterfactual influence.",
  dependencies: {
    mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
    socialState: "AgentSocialState.norms and AgentSocialState.normSanctions for record denominators"
  },
  aggregation: "zero_weight_norm_sanction_lifecycle_temporal_association_by_agent",
  visibility: "postgame"
};
export const GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID = "evaluation.gossip-exposure-temporal-association.v1";
export const GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.gossip_exposure_temporal_association_count",
  "agent.social.gossip_exposure_temporal_association_rate",
  "agent.social.gossip_exposure_temporal_evaluable_record_rate"
];
export const GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.gossip-exposure-temporal-association.evaluation-context.v1",
  outputSchema: "harness.gossip-exposure-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits whether explicit gossip records cite message evidence that was present in the same agent's scoped social exposure records before the gossip.added journal entry. This is a zero-weight temporal association baseline and does not assert gossip truth, spread, persuasion, reputation impact, reward impact, deception success, or counterfactual influence.",
  dependencies: {
    socialExposure: "SocialExposureRecord records from deriveSocialExposureRecords() over SocialEpisodeArtifact steps/messages",
    mutationJournal: "AgentSocialState.journal.entries with store gossip, mutationKind gossip.added, subjectId, turnIndex, hiddenTruthUsed, and evidenceRefs",
    socialState: "AgentSocialState.gossip records for record denominators"
  },
  aggregation: "zero_weight_gossip_exposure_temporal_association_by_agent",
  visibility: "postgame"
};
export const TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.trust-repair-lifecycle-temporal-association.v1";
export const TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.trust_repair_status_temporal_association_count",
  "agent.social.trust_repair_status_temporal_association_rate",
  "agent.social.trust_repair_status_temporal_evaluable_record_rate"
];
export const TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.trust-repair-lifecycle-temporal-association.evaluation-context.v1",
  outputSchema: "harness.trust-repair-lifecycle-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits ordered mutation-journal lifecycle associations for trust repair records using a strict turnIndex-after-creation ordering rule. It only compares explicit trust_repair.added to later trust_repair.status.updated entries. This is a zero-weight temporal association baseline and does not assert causality, completed repair outcome, repair effectiveness, relationship change, reputation recovery, persuasion, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {
    mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
    socialState: "AgentSocialState.trustRepairs records for record denominators"
  },
  aggregation: "zero_weight_trust_repair_lifecycle_temporal_association_by_agent",
  visibility: "postgame"
};
export const TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.trust-repair-relationship-temporal-association.v1";
export const TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.trust_repair_relationship_temporal_association_count",
  "agent.social.trust_repair_relationship_temporal_association_rate",
  "agent.social.trust_repair_relationship_temporal_evaluable_record_rate"
];
export const TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.trust-repair-relationship-temporal-association.evaluation-context.v1",
  outputSchema: "harness.trust-repair-relationship-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits whether explicit trust repair records are followed by later relationship.updated journal entries for the repair actor under a strict turnIndex-after-creation ordering rule. This is a zero-weight temporal association baseline and does not assert causality, repair effectiveness, relationship restoration, reputation recovery, persuasion, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {
    mutationJournal:
      "AgentSocialState.journal.entries with store trustRepairs/relationships, mutationKind trust_repair.added/relationship.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
    socialState: "AgentSocialState.trustRepairs records and AgentSocialState.relationships edges for record denominators"
  },
  aggregation: "zero_weight_trust_repair_relationship_temporal_association_by_agent",
  visibility: "postgame"
};
export const TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.trust-repair-reputation-temporal-association.v1";
export const TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.trust_repair_reputation_temporal_association_count",
  "agent.social.trust_repair_reputation_temporal_association_rate",
  "agent.social.trust_repair_reputation_temporal_evaluable_record_rate"
];
export const TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.trust-repair-reputation-temporal-association.evaluation-context.v1",
  outputSchema: "harness.trust-repair-reputation-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits whether explicit trust repair records are followed by later reputation.updated journal entries for the repair actor under a strict turnIndex-after-creation ordering rule. This is a zero-weight temporal association baseline and does not assert causality, repair effectiveness, relationship restoration, reputation recovery, persuasion, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {
    mutationJournal:
      "AgentSocialState.journal.entries with store trustRepairs/reputation, mutationKind trust_repair.added/reputation.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
    socialState: "AgentSocialState.trustRepairs records and AgentSocialState.reputation records for record denominators"
  },
  aggregation: "zero_weight_trust_repair_reputation_temporal_association_by_agent",
  visibility: "postgame"
};
export const BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID =
  "evaluation.betrayal-lifecycle-temporal-association.v1";
export const BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS = [
  "agent.social.betrayal_lifecycle_temporal_association_count",
  "agent.social.betrayal_lifecycle_temporal_association_rate",
  "agent.social.betrayal_lifecycle_temporal_evaluable_record_rate"
];
export const BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "harness.betrayal-lifecycle-temporal-association.evaluation-context.v1",
  outputSchema: "harness.betrayal-lifecycle-temporal-association.summary.v1",
  mode: "deterministic",
  metricIds: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits ordered mutation-journal lifecycle associations for betrayal records using a strict turnIndex-after-creation ordering rule. It only compares explicit betrayal.added to later betrayal.evidence.recorded entries. This is a zero-weight temporal association baseline and does not assert betrayal truth, betrayal intent, causality, relationship damage, reputation damage, coalition failure, reward impact, leaderboard value, or counterfactual influence.",
  dependencies: {
    mutationJournal:
      "AgentSocialState.journal.entries with store betrayals, mutationKind betrayal.added/betrayal.evidence.recorded, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
    socialState: "AgentSocialState.betrayals records for record denominators"
  },
  aggregation: "zero_weight_betrayal_lifecycle_temporal_association_by_agent",
  visibility: "postgame"
};

export interface SocialStateEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  memoryEntries: number;
  reflectionEntries: number;
  outcomeEntries: number;
  beliefClaims: number;
  relationshipEdges: number;
  reputationRecords: number;
  norms: number;
  goals: number;
  commitments: number;
  coalitions: number;
  gossip: number;
  normSanctions: number;
  trustRepairs: number;
  betrayals: number;
  journalEntries: number;
  agentsWithJournal: number;
}

export interface SocialDynamicsEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  influenceEdges: number;
  coordinationMessages: number;
  coalitionSignals: number;
  exposureRecords: number;
  publicExposureRecords: number;
  reputationRecords: number;
  normPressureRecords: number;
}

export interface SocialFactIngestEvidenceEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  agentsWithExposureRecords: number;
  exposureRecords: number;
  commitmentSpeechActCandidates: number;
  commitmentSpeechActLinkedCandidates: number;
  commitmentSpeechActMissingMutationCandidates: number;
  coalitionSpeechActCandidates: number;
  coalitionSpeechActLinkedCandidates: number;
  coalitionSpeechActMissingMutationCandidates: number;
  relationshipFactCandidates: number;
  relationshipFactLinkedCandidates: number;
  relationshipFactMissingMutationCandidates: number;
  reputationFactCandidates: number;
  reputationFactLinkedCandidates: number;
  reputationFactMissingMutationCandidates: number;
}

export interface CommitmentCoalitionAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  commitments: number;
  coalitions: number;
  totalPairs: number;
  evaluablePairs: number;
  associatedPairs: number;
}

export interface CommitmentCoalitionLifecycleTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  commitments: number;
  commitmentEvaluableRecords: number;
  commitmentAssociatedRecords: number;
  commitmentMissingCreationRecords: number;
  commitmentAmbiguousOrderingRecords: number;
  commitmentNoLaterStatusUpdateRecords: number;
  coalitions: number;
  coalitionEvaluableRecords: number;
  coalitionAssociatedRecords: number;
  coalitionMissingCreationRecords: number;
  coalitionAmbiguousOrderingRecords: number;
  coalitionNoLaterLifecycleEvidenceRecords: number;
}

export interface NormSanctionLifecycleTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  norms: number;
  normEvaluableRecords: number;
  normAssociatedRecords: number;
  normMissingCreationRecords: number;
  normAmbiguousOrderingRecords: number;
  normNoLaterStatusUpdateRecords: number;
  normSanctions: number;
  normSanctionEvaluableRecords: number;
  normSanctionAssociatedRecords: number;
  normSanctionMissingCreationRecords: number;
  normSanctionAmbiguousOrderingRecords: number;
  normSanctionNoLaterStatusUpdateRecords: number;
}

export interface GossipExposureTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  agentsWithExposureRecords: number;
  exposureRecords: number;
  gossipRecords: number;
  gossipEvaluableRecords: number;
  gossipAssociatedRecords: number;
  gossipMissingCreationRecords: number;
  gossipMissingMessageEvidenceRecords: number;
  gossipMissingScopedExposureRecords: number;
  gossipAmbiguousOrderingRecords: number;
  gossipSameTurnIngestionRecords: number;
  gossipNoLaterCreationRecords: number;
}

export interface TrustRepairLifecycleTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  trustRepairs: number;
  trustRepairEvaluableRecords: number;
  trustRepairAssociatedRecords: number;
  trustRepairMissingCreationRecords: number;
  trustRepairAmbiguousOrderingRecords: number;
  trustRepairNoLaterStatusUpdateRecords: number;
}

export interface TrustRepairRelationshipTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  trustRepairs: number;
  relationshipEdges: number;
  trustRepairRelationshipEvaluableRecords: number;
  trustRepairRelationshipAssociatedRecords: number;
  trustRepairRelationshipMissingCreationRecords: number;
  trustRepairRelationshipAmbiguousOrderingRecords: number;
  trustRepairRelationshipSameTurnMutationRecords: number;
  trustRepairRelationshipNoLaterRelationshipUpdateRecords: number;
}

export interface TrustRepairReputationTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  trustRepairs: number;
  reputationRecords: number;
  trustRepairReputationEvaluableRecords: number;
  trustRepairReputationAssociatedRecords: number;
  trustRepairReputationMissingCreationRecords: number;
  trustRepairReputationAmbiguousOrderingRecords: number;
  trustRepairReputationSameTurnMutationRecords: number;
  trustRepairReputationNoLaterReputationUpdateRecords: number;
}

export interface BetrayalLifecycleTemporalAssociationEvaluation {
  agentCount: number;
  agentsWithSocialState: number;
  agentsWithJournal: number;
  betrayals: number;
  betrayalEvaluableRecords: number;
  betrayalAssociatedRecords: number;
  betrayalMissingCreationRecords: number;
  betrayalAmbiguousOrderingRecords: number;
  betrayalNoLaterLifecycleEvidenceRecords: number;
}

export function createSocialStateEvaluator<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown>(): SocialEvaluator<
  TState,
  TMetrics,
  TSocialEpisode,
  SocialStateEvaluation
> {
  return {
    id: SOCIAL_STATE_EVALUATOR_ID,
    label: "Social state evaluator",
    version: "1.0.0",
    manifest: SOCIAL_STATE_EVALUATOR_MANIFEST,
    evaluate(context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>): HarnessEvaluationModuleResult<SocialStateEvaluation> {
      const metrics = metricsFromSocialState(context.agents);
      return {
        evaluatorId: SOCIAL_STATE_EVALUATOR_ID,
        label: "Social state evaluator",
        version: "1.0.0",
        metrics,
        output: summarizeSocialState(context.agents)
      };
    }
  };
}

export function createCommitmentCoalitionAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, CommitmentCoalitionAssociationEvaluation> {
  return {
    id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
    label: "Commitment-coalition association evaluator",
    version: "1.0.0",
    manifest: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>): HarnessEvaluationModuleResult<CommitmentCoalitionAssociationEvaluation> {
      return {
        evaluatorId: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
        label: "Commitment-coalition association evaluator",
        version: "1.0.0",
        metrics: metricsFromCommitmentCoalitionAssociations(context.agents),
        output: summarizeCommitmentCoalitionAssociations(context.agents)
      };
    }
  };
}

export function createCommitmentCoalitionLifecycleTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, CommitmentCoalitionLifecycleTemporalAssociationEvaluation> {
  return {
    id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Commitment-coalition lifecycle temporal association evaluator",
    version: "1.0.0",
    manifest: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<CommitmentCoalitionLifecycleTemporalAssociationEvaluation> {
      return {
        evaluatorId: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Commitment-coalition lifecycle temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromCommitmentCoalitionLifecycleTemporalAssociations(context.agents),
        output: summarizeCommitmentCoalitionLifecycleTemporalAssociations(context.agents)
      };
    }
  };
}

export function createNormSanctionLifecycleTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, NormSanctionLifecycleTemporalAssociationEvaluation> {
  return {
    id: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Norm-sanction lifecycle temporal association evaluator",
    version: "1.0.0",
    manifest: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<NormSanctionLifecycleTemporalAssociationEvaluation> {
      return {
        evaluatorId: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Norm-sanction lifecycle temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromNormSanctionLifecycleTemporalAssociations(context.agents),
        output: summarizeNormSanctionLifecycleTemporalAssociations(context.agents)
      };
    }
  };
}

export function createGossipExposureTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, GossipExposureTemporalAssociationEvaluation> {
  return {
    id: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Gossip-exposure temporal association evaluator",
    version: "1.0.0",
    manifest: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<GossipExposureTemporalAssociationEvaluation> {
      return {
        evaluatorId: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Gossip-exposure temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromGossipExposureTemporalAssociations(context.agents, context.socialEpisode),
        output: summarizeGossipExposureTemporalAssociations(context.agents, context.socialEpisode)
      };
    }
  };
}

export function createTrustRepairLifecycleTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, TrustRepairLifecycleTemporalAssociationEvaluation> {
  return {
    id: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Trust-repair lifecycle temporal association evaluator",
    version: "1.0.0",
    manifest: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<TrustRepairLifecycleTemporalAssociationEvaluation> {
      return {
        evaluatorId: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Trust-repair lifecycle temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromTrustRepairLifecycleTemporalAssociations(context.agents),
        output: summarizeTrustRepairLifecycleTemporalAssociations(context.agents)
      };
    }
  };
}

export function createTrustRepairRelationshipTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, TrustRepairRelationshipTemporalAssociationEvaluation> {
  return {
    id: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Trust-repair relationship temporal association evaluator",
    version: "1.0.0",
    manifest: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<TrustRepairRelationshipTemporalAssociationEvaluation> {
      return {
        evaluatorId: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Trust-repair relationship temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromTrustRepairRelationshipTemporalAssociations(context.agents),
        output: summarizeTrustRepairRelationshipTemporalAssociations(context.agents)
      };
    }
  };
}

export function createTrustRepairReputationTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, TrustRepairReputationTemporalAssociationEvaluation> {
  return {
    id: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Trust-repair reputation temporal association evaluator",
    version: "1.0.0",
    manifest: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<TrustRepairReputationTemporalAssociationEvaluation> {
      return {
        evaluatorId: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Trust-repair reputation temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromTrustRepairReputationTemporalAssociations(context.agents),
        output: summarizeTrustRepairReputationTemporalAssociations(context.agents)
      };
    }
  };
}

export function createBetrayalLifecycleTemporalAssociationEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, BetrayalLifecycleTemporalAssociationEvaluation> {
  return {
    id: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    label: "Betrayal lifecycle temporal association evaluator",
    version: "1.0.0",
    manifest: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<BetrayalLifecycleTemporalAssociationEvaluation> {
      return {
        evaluatorId: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        label: "Betrayal lifecycle temporal association evaluator",
        version: "1.0.0",
        metrics: metricsFromBetrayalLifecycleTemporalAssociations(context.agents),
        output: summarizeBetrayalLifecycleTemporalAssociations(context.agents)
      };
    }
  };
}

export function createSocialDynamicsEvaluator<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown>(): SocialEvaluator<
  TState,
  TMetrics,
  TSocialEpisode,
  SocialDynamicsEvaluation
> {
  return {
    id: SOCIAL_DYNAMICS_EVALUATOR_ID,
    label: "Social dynamics evaluator",
    version: "1.0.0",
    manifest: SOCIAL_DYNAMICS_EVALUATOR_MANIFEST,
    evaluate(context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>): HarnessEvaluationModuleResult<SocialDynamicsEvaluation> {
      return {
        evaluatorId: SOCIAL_DYNAMICS_EVALUATOR_ID,
        label: "Social dynamics evaluator",
        version: "1.0.0",
        metrics: [...metricsFromSocialDynamics(context.agents), ...metricsFromSocialExposure(context.agents, context.socialEpisode)],
        output: summarizeSocialDynamics(context.agents, context.socialEpisode)
      };
    }
  };
}

export function createSocialFactIngestEvidenceEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown
>(): SocialEvaluator<TState, TMetrics, TSocialEpisode, SocialFactIngestEvidenceEvaluation> {
  return {
    id: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
    label: "Social fact ingest evidence evaluator",
    version: "1.0.0",
    manifest: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_MANIFEST,
    evaluate(
      context: SocialEvaluationContext<TState, TMetrics, TSocialEpisode>
    ): HarnessEvaluationModuleResult<SocialFactIngestEvidenceEvaluation> {
      return {
        evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
        label: "Social fact ingest evidence evaluator",
        version: "1.0.0",
        metrics: metricsFromSocialFactIngestEvidence(context.agents, context.socialEpisode),
        output: summarizeSocialFactIngestEvidence(context.agents, context.socialEpisode)
      };
    }
  };
}

export function metricsFromSocialState(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => metricsForAgent(agent));
}

export function metricsFromSocialDynamics(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => dynamicsMetricsForAgent(agent));
}

export function metricsFromSocialFactIngestEvidence(agents: SocialAgentSnapshot[], socialEpisode?: unknown): HarnessMetricRecord[] {
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  const recordsByObserver = groupExposureRecordsByObserver(exposureRecords);
  const messages = messagesFromSocialEpisode(socialEpisode);
  const messageIndex = socialMessageIndex(messages);
  return agents.flatMap((agent) => socialFactIngestEvidenceMetricsForAgent(agent, recordsByObserver.get(socialAgentId(agent)) ?? [], messageIndex));
}

export function metricsFromCommitmentCoalitionAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => commitmentCoalitionAssociationMetricsForAgent(agent));
}

export function metricsFromCommitmentCoalitionLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => commitmentCoalitionLifecycleTemporalMetricsForAgent(agent));
}

export function metricsFromNormSanctionLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => normSanctionLifecycleTemporalMetricsForAgent(agent));
}

export function metricsFromGossipExposureTemporalAssociations(agents: SocialAgentSnapshot[], socialEpisode?: unknown): HarnessMetricRecord[] {
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  const recordsByObserver = groupExposureRecordsByObserver(exposureRecords);
  return agents.flatMap((agent) => gossipExposureTemporalMetricsForAgent(agent, recordsByObserver.get(socialAgentId(agent)) ?? [], exposureRecords.length));
}

export function metricsFromTrustRepairLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => trustRepairLifecycleTemporalMetricsForAgent(agent));
}

export function metricsFromTrustRepairRelationshipTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => trustRepairRelationshipTemporalMetricsForAgent(agent));
}

export function metricsFromTrustRepairReputationTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => trustRepairReputationTemporalMetricsForAgent(agent));
}

export function metricsFromBetrayalLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): HarnessMetricRecord[] {
  return agents.flatMap((agent) => betrayalLifecycleTemporalMetricsForAgent(agent));
}

export function metricsFromSocialExposure(agents: SocialAgentSnapshot[], socialEpisode?: unknown): HarnessMetricRecord[] {
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  if (!exposureRecords.length) return [];

  const recordsByObserver = groupExposureRecordsByObserver(exposureRecords);
  const uniqueSourcesAcrossEpisode = new Set(exposureRecords.map((record) => record.sourceId)).size;
  const publicExposureRecords = exposureRecords.filter((record) => record.visibility === "public");
  return agents.flatMap((agent) =>
    exposureMetricsForAgent(agent, recordsByObserver.get(socialAgentId(agent)) ?? [], {
      totalExposureRecords: exposureRecords.length,
      publicExposureRecords: publicExposureRecords.length,
      uniqueSourcesAcrossEpisode
    })
  );
}

type SocialFactIngestCandidateKind = "commitment" | "coalition" | "relationship" | "reputation";

interface SocialFactIngestCandidate {
  kind: SocialFactIngestCandidateKind;
  recordId: string;
  messageId: string;
  messageSeq: number;
  observerId: string;
  exposureRecord: SocialExposureRecord;
  speechActId?: string;
  speechActKind?: string;
  speechActIndex?: number;
  factKind?: string;
  factIndex?: number;
}

interface SocialFactIngestRecordEvaluation {
  candidate: SocialFactIngestCandidate;
  linked: boolean;
  missingMutation: boolean;
  mutationEntries: SocialStateMutationJournalEntry[];
}

type SocialMessageIndex = {
  byId: Map<string, SocialMessage>;
  bySeq: Map<number, SocialMessage>;
};

function socialFactIngestEvidenceMetricsForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  messages: SocialMessageIndex
): HarnessMetricRecord[] {
  const subject = socialSubject(agent);
  const evaluations = evaluateSocialFactIngestEvidenceForAgent(agent, exposureRecords, messages);
  return [
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "commitment", {
      countId: "agent.social.commitment_speech_act_ingest_link_count",
      rateId: "agent.social.commitment_speech_act_ingest_link_rate",
      countLabel: "Agent social commitment speech-act ingest link count",
      rateLabel: "Agent social commitment speech-act ingest link rate",
      candidateLabel: "commitmentSpeechActCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "coalition", {
      countId: "agent.social.coalition_speech_act_ingest_link_count",
      rateId: "agent.social.coalition_speech_act_ingest_link_rate",
      countLabel: "Agent social coalition speech-act ingest link count",
      rateLabel: "Agent social coalition speech-act ingest link rate",
      candidateLabel: "coalitionSpeechActCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "relationship", {
      countId: "agent.social.relationship_fact_ingest_link_count",
      rateId: "agent.social.relationship_fact_ingest_link_rate",
      countLabel: "Agent social relationship fact ingest link count",
      rateLabel: "Agent social relationship fact ingest link rate",
      candidateLabel: "relationshipFactCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "reputation", {
      countId: "agent.social.reputation_fact_ingest_link_count",
      rateId: "agent.social.reputation_fact_ingest_link_rate",
      countLabel: "Agent social reputation fact ingest link count",
      rateLabel: "Agent social reputation fact ingest link rate",
      candidateLabel: "reputationFactCandidates"
    })
  ];
}

function socialFactIngestEvidenceMetricPair(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evaluations: SocialFactIngestRecordEvaluation[],
  kind: SocialFactIngestCandidateKind,
  labels: {
    countId: string;
    rateId: string;
    countLabel: string;
    rateLabel: string;
    candidateLabel: string;
  }
): HarnessMetricRecord[] {
  const records = evaluations.filter((item) => item.candidate.kind === kind);
  const linkedRecords = records.filter((item) => item.linked);
  const evidenceRefs = evidenceFromSocialFactIngestRecords(agent, linkedRecords);
  const metadata = {
    candidateKind: kind,
    [labels.candidateLabel]: records.length,
    linkedCandidates: linkedRecords.length,
    missingMutationCandidates: records.filter((item) => item.missingMutation).length,
    sampleLinkedCandidates: sampleSocialFactIngestCandidates(linkedRecords),
    sampleMissingMutationCandidates: sampleSocialFactIngestCandidates(records.filter((item) => item.missingMutation)),
    coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
    causalClaim: false
  };
  return [
    socialFactIngestMetric(agent, subject, evidenceRefs, {
      id: labels.countId,
      label: labels.countLabel,
      value: linkedRecords.length,
      unit: "count",
      denominator: records.length,
      confidence: confidence(records.length),
      aggregation: "sum",
      metadata
    }),
    socialFactIngestMetric(agent, subject, evidenceRefs, {
      id: labels.rateId,
      label: labels.rateLabel,
      value: ratio(linkedRecords.length, records.length),
      unit: "ratio",
      denominator: records.length,
      confidence: confidence(records.length),
      aggregation: "ratio",
      metadata
    })
  ];
}

function socialFactIngestMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    unit: "count" | "ratio";
    denominator: number;
    confidence: number;
    aggregation: "sum" | "ratio";
    metadata: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: options.unit,
    higherIsBetter: true,
    weight: 0,
    source: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
    evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
    evaluatorVersion: "1.0.0",
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function evaluateSocialFactIngestEvidenceForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  messages: SocialMessageIndex
): SocialFactIngestRecordEvaluation[] {
  const candidates = socialFactIngestCandidatesFromExposure(exposureRecords, messages);
  const journalEntries = agent.social?.journal?.entries ?? [];
  return candidates.map((candidate) => {
    const mutationEntries = journalEntries.filter((entry) => socialFactIngestCandidateMatchesMutation(candidate, entry));
    return {
      candidate,
      linked: mutationEntries.length > 0,
      missingMutation: mutationEntries.length === 0,
      mutationEntries
    };
  });
}

function socialFactIngestCandidatesFromExposure(exposureRecords: SocialExposureRecord[], messages: SocialMessageIndex): SocialFactIngestCandidate[] {
  const candidates: SocialFactIngestCandidate[] = [];
  for (const exposureRecord of exposureRecords) {
    const message = messages.byId.get(exposureRecord.messageId) ?? messages.bySeq.get(exposureRecord.messageSeq);
    if (!message) continue;
    const speechActs = Array.isArray(message.speechActs) ? message.speechActs.filter(isSocialSpeechActForEvaluation) : [];
    for (const [speechActIndex, act] of speechActs.entries()) {
      const candidate = socialFactIngestCandidateFromSpeechAct(message, exposureRecord, act, speechActIndex);
      if (candidate) candidates.push(candidate);
    }
    for (const [factIndex, fact] of socialFactsFromMessage(message).entries()) {
      const candidate = socialFactIngestCandidateFromStructuredFact(message, exposureRecord, fact, factIndex);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function socialFactIngestCandidateFromSpeechAct(
  message: SocialMessage,
  exposureRecord: SocialExposureRecord,
  act: SocialSpeechAct,
  speechActIndex: number
): SocialFactIngestCandidate | undefined {
  if (isMetadataDerivedSocialSpeechAct(act)) return undefined;
  if (act.kind === "commitment") {
    const promisedAction = stringMetadataValue(act.metadata?.promisedAction) ?? stringMetadataValue(act.value);
    const stance = stringMetadataValue(act.metadata?.stance);
    if (!promisedAction && !stance) return undefined;
    const speechActId = speechActIdForEvaluation(act, speechActIndex);
    return {
      kind: "commitment",
      recordId: stringMetadataValue(act.metadata?.commitmentId) ?? `${message.id}:speech-act:${speechActId}:commitment`,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      speechActId,
      speechActKind: act.kind,
      speechActIndex
    };
  }
  if (act.kind === "coalition_signal") {
    const memberIds = stringArrayMetadataValue(act.metadata?.memberIds);
    if (!memberIds.length) return undefined;
    const speechActId = speechActIdForEvaluation(act, speechActIndex);
    return {
      kind: "coalition",
      recordId: stringMetadataValue(act.metadata?.coalitionId) ?? `${message.id}:speech-act:${speechActId}:coalition`,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      speechActId,
      speechActKind: act.kind,
      speechActIndex
    };
  }
  return undefined;
}

function socialFactIngestCandidateFromStructuredFact(
  message: SocialMessage,
  exposureRecord: SocialExposureRecord,
  fact: Record<string, unknown>,
  factIndex: number
): SocialFactIngestCandidate | undefined {
  const kind = stringMetadataValue(fact.kind);
  if (kind === "relationship") {
    const targetId = stringMetadataValue(fact.targetId);
    if (!targetId || !hasNumericDelta(fact.deltas, RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS)) return undefined;
    return {
      kind: "relationship",
      recordId: targetId,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      factKind: "relationship",
      factIndex
    };
  }
  if (kind === "reputation") {
    const subjectId = stringMetadataValue(fact.subjectId) ?? stringMetadataValue(fact.targetId);
    if (!subjectId || !hasNumericDelta(fact.deltas, REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS)) return undefined;
    return {
      kind: "reputation",
      recordId: subjectId,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      factKind: "reputation",
      factIndex
    };
  }
  return undefined;
}

function socialFactIngestCandidateMatchesMutation(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  if (entry.hiddenTruthUsed !== false) return false;
  if (entry.agentId !== candidate.observerId) return false;
  const entryObserverId = stringMetadataValue(entry.metadata?.observerId);
  if (entryObserverId && entryObserverId !== candidate.observerId) return false;
  if (!mutationMatchesCandidateStore(candidate, entry)) return false;
  if (entry.subjectId !== candidate.recordId) return false;
  if (!entryMatchesMessage(candidate, entry)) return false;
  if (candidate.speechActId && stringMetadataValue(entry.metadata?.speechActId) !== candidate.speechActId) return false;
  if (candidate.speechActKind && stringMetadataValue(entry.metadata?.speechActKind) !== candidate.speechActKind) return false;
  if (candidate.speechActIndex !== undefined && entry.metadata?.speechActIndex !== candidate.speechActIndex) return false;
  if (candidate.factKind && stringMetadataValue(entry.metadata?.factKind) !== candidate.factKind) return false;
  if (candidate.factIndex !== undefined && entry.metadata?.factIndex !== candidate.factIndex) return false;
  return true;
}

function mutationMatchesCandidateStore(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  if (candidate.kind === "commitment") return entry.store === "commitments" && entry.mutationKind === "commitment.added";
  if (candidate.kind === "coalition") return entry.store === "coalitions" && entry.mutationKind === "coalition.added";
  if (candidate.kind === "relationship") return entry.store === "relationships" && entry.mutationKind === "relationship.updated";
  return entry.store === "reputation" && entry.mutationKind === "reputation.updated";
}

function entryMatchesMessage(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  const metadataMessageId = stringMetadataValue(entry.metadata?.messageId);
  const metadataMessageSeq = typeof entry.metadata?.messageSeq === "number" ? entry.metadata.messageSeq : undefined;
  if (metadataMessageId !== undefined && metadataMessageId !== candidate.messageId) return false;
  if (metadataMessageSeq !== undefined && metadataMessageSeq !== candidate.messageSeq) return false;
  if (entry.evidenceRefs.some((ref) => ref.artifact === "message" && (ref.id === candidate.messageId || ref.seq === candidate.messageSeq))) return true;
  return entry.messageSeqRange?.start === candidate.messageSeq && entry.messageSeqRange.end === candidate.messageSeq;
}

function evidenceFromSocialFactIngestRecords(
  agent: SocialAgentSnapshot,
  records: SocialFactIngestRecordEvaluation[]
): HarnessMetricEvidenceRef[] {
  const exposureEvidence = records.flatMap((record) => evidenceFromExposureRecords(agent, [record.candidate.exposureRecord]));
  const mutationEvidence = records.flatMap((record) => evidenceFromSocialRefs(agent, record.mutationEntries.flatMap((entry) => entry.evidenceRefs)));
  const mutationTraceEvidence = records.flatMap((record) =>
    record.mutationEntries.flatMap((entry) => entry.traceId ? [{ artifact: "trace" as const, traceId: entry.traceId, description: entry.mutationKind }] : [])
  );
  return uniqueEvidenceRefs([...exposureEvidence, ...mutationEvidence, ...mutationTraceEvidence, ...agentStateEvidence(agent)]);
}

function sampleSocialFactIngestCandidates(records: SocialFactIngestRecordEvaluation[]): Array<{
  kind: SocialFactIngestCandidateKind;
  recordId: string;
  messageId: string;
  messageSeq: number;
  speechActId?: string;
  speechActKind?: string;
  factKind?: string;
  factIndex?: number;
}> {
  return records.slice(0, 20).map((record) => ({
    kind: record.candidate.kind,
    recordId: record.candidate.recordId,
    messageId: record.candidate.messageId,
    messageSeq: record.candidate.messageSeq,
    speechActId: record.candidate.speechActId,
    speechActKind: record.candidate.speechActKind,
    factKind: record.candidate.factKind,
    factIndex: record.candidate.factIndex
  }));
}

function metricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const evidenceRefs = agentStateEvidence(agent);
  const memoryEntries = social.memory.entries;
  const journalEntries = social.journal?.entries ?? [];
  const beliefClaims = Object.values(social.beliefs.claims);
  const relationshipEdges = Object.values(social.relationships.edges);
  const reputationRecords = Object.values(social.reputation.records);
  const norms = Object.values(social.norms.norms);
  const goals = social.goals.goals;
  const commitments = Object.values(social.commitments?.records ?? {});
  const coalitions = Object.values(social.coalitions?.records ?? {});
  const gossip = Object.values(social.gossip?.records ?? {});
  const normSanctions = Object.values(social.normSanctions?.records ?? {});
  const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
  const betrayals = Object.values(social.betrayals?.records ?? {});
  const evidenceBackedMemory = memoryEntries.filter((entry) => entry.evidenceRefs.length > 0);
  const evidenceBackedJournal = journalEntries.filter((entry) => entry.evidenceRefs.length > 0);
  const evidenceBackedBeliefs = beliefClaims.filter((claim) => claim.evidenceRefs.length > 0);
  const evidenceBackedCommitments = commitments.filter((record) => record.evidenceRefs.length > 0);
  const evidenceBackedCoalitions = coalitions.filter((record) => record.evidenceRefs.length > 0);
  const evidenceBackedGossip = gossip.filter((record) => record.evidenceRefs.length > 0);
  const evidenceBackedNormSanctions = normSanctions.filter((record) => record.evidenceRefs.length > 0);
  const evidenceBackedTrustRepairs = trustRepairs.filter((record) => record.evidenceRefs.length > 0);
  const evidenceBackedBetrayals = betrayals.filter((record) => record.evidenceRefs.length > 0);
  const journalStores = [...new Set(journalEntries.map((entry) => entry.store))].sort();
  const journalEvidence = evidenceFromSocialRefs(agent, journalEntries.flatMap((entry) => entry.evidenceRefs));

  return [
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.memory_count",
      label: "Agent social memory count",
      value: memoryEntries.length,
      denominator: social.memory.maxEntries,
      metadata: {
        maxEntries: social.memory.maxEntries,
        observationEntries: memoryEntries.filter((entry) => entry.kind === "observation").length,
        messageEntries: memoryEntries.filter((entry) => entry.kind === "message").length,
        memoEntries: memoryEntries.filter((entry) => entry.kind === "memo").length,
        decisionEntries: memoryEntries.filter((entry) => entry.kind === "decision").length,
        reflectionEntries: memoryEntries.filter((entry) => entry.kind === "reflection").length,
        outcomeEntries: memoryEntries.filter((entry) => entry.kind === "outcome").length
      }
    }),
    ratioMetric(agent, subject, evidenceRefs, {
      id: "agent.social.evidenced_memory_rate",
      label: "Agent social evidenced memory rate",
      value: ratio(evidenceBackedMemory.length, memoryEntries.length),
      denominator: memoryEntries.length,
      confidence: confidence(memoryEntries.length),
      metadata: { evidenceBackedEntries: evidenceBackedMemory.length, memoryEntries: memoryEntries.length }
    }),
    countMetric(agent, subject, journalEvidence, {
      id: "agent.social.journal_entry_count",
      label: "Agent social mutation journal entry count",
      value: journalEntries.length,
      denominator: social.journal?.maxEntries,
      metadata: {
        schemaVersion: social.journal?.schemaVersion ?? null,
        nextSeq: social.journal?.nextSeq ?? null,
        mutationKinds: sampleIds(journalEntries.map((entry) => entry.mutationKind)),
        stores: journalStores,
        hiddenTruthUsedCount: journalEntries.filter((entry) => entry.hiddenTruthUsed).length
      }
    }),
    ratioMetric(agent, subject, journalEvidence, {
      id: "agent.social.evidenced_journal_rate",
      label: "Agent social evidenced mutation journal rate",
      value: ratio(evidenceBackedJournal.length, journalEntries.length),
      denominator: journalEntries.length,
      confidence: confidence(journalEntries.length),
      metadata: {
        evidenceBackedJournalEntries: evidenceBackedJournal.length,
        journalEntries: journalEntries.length,
        hiddenTruthUsedCount: journalEntries.filter((entry) => entry.hiddenTruthUsed).length
      }
    }),
    countMetric(agent, subject, journalEvidence, {
      id: "agent.social.journal_store_coverage_count",
      label: "Agent social mutation journal store coverage count",
      value: journalStores.length,
      denominator: 13,
      metadata: {
        stores: journalStores,
        mutationKinds: sampleIds([...new Set(journalEntries.map((entry) => entry.mutationKind))].sort())
      }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.belief_count",
      label: "Agent social belief count",
      value: beliefClaims.length,
      metadata: { claimIds: sampleIds(beliefClaims.map((claim) => claim.id)) }
    }),
    ratioMetric(agent, subject, evidenceRefs, {
      id: "agent.social.evidenced_belief_rate",
      label: "Agent social evidenced belief rate",
      value: ratio(evidenceBackedBeliefs.length, beliefClaims.length),
      denominator: beliefClaims.length,
      confidence: confidence(beliefClaims.length),
      metadata: { evidenceBackedBeliefs: evidenceBackedBeliefs.length, beliefClaims: beliefClaims.length }
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_belief_confidence",
      label: "Agent social average belief confidence",
      value: average(beliefClaims.map((claim) => claim.confidence)),
      denominator: beliefClaims.length,
      metadata: { beliefClaims: beliefClaims.length }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.relationship_edge_count",
      label: "Agent social relationship edge count",
      value: relationshipEdges.length,
      metadata: { targetIds: sampleIds(relationshipEdges.map((edge) => edge.targetId)) }
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_trust",
      label: "Agent social average trust",
      value: average(relationshipEdges.map((edge) => edge.trust)),
      denominator: relationshipEdges.length
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_suspicion",
      label: "Agent social average suspicion",
      value: average(relationshipEdges.map((edge) => edge.suspicion)),
      denominator: relationshipEdges.length
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_influence",
      label: "Agent social average influence",
      value: average(relationshipEdges.map((edge) => edge.influence)),
      denominator: relationshipEdges.length
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.reputation_record_count",
      label: "Agent social reputation record count",
      value: reputationRecords.length,
      metadata: { subjectIds: sampleIds(reputationRecords.map((record) => record.subjectId)) }
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_reputation_honesty",
      label: "Agent social average reputation honesty",
      value: average(reputationRecords.map((record) => record.honesty)),
      denominator: reputationRecords.length
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_reputation_cooperation",
      label: "Agent social average reputation cooperation",
      value: average(reputationRecords.map((record) => record.cooperation)),
      denominator: reputationRecords.length
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_reputation_threat",
      label: "Agent social average reputation threat",
      value: average(reputationRecords.map((record) => record.threat)),
      denominator: reputationRecords.length
    }),
    averageMetric(agent, subject, evidenceRefs, {
      id: "agent.social.avg_norm_compliance",
      label: "Agent social average norm compliance reputation",
      value: average(reputationRecords.map((record) => record.normCompliance)),
      denominator: reputationRecords.length
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.norm_count",
      label: "Agent social norm count",
      value: norms.length,
      metadata: { normIds: sampleIds(norms.map((norm) => norm.id)) }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.violated_norm_count",
      label: "Agent social violated norm count",
      value: norms.filter((norm) => norm.status === "violated").length,
      denominator: norms.length,
      metadata: { normCount: norms.length }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.fulfilled_norm_count",
      label: "Agent social fulfilled norm count",
      value: norms.filter((norm) => norm.status === "fulfilled").length,
      denominator: norms.length,
      metadata: { normCount: norms.length }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.goal_count",
      label: "Agent social goal count",
      value: goals.length,
      metadata: { goalIds: sampleIds(goals.map((goal) => goal.id)) }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.active_goal_count",
      label: "Agent social active goal count",
      value: goals.filter((goal) => goal.status === "active").length,
      denominator: goals.length,
      metadata: { goalCount: goals.length }
    }),
    countMetric(agent, subject, evidenceRefs, {
      id: "agent.social.completed_goal_count",
      label: "Agent social completed goal count",
      value: goals.filter((goal) => goal.status === "completed").length,
      denominator: goals.length,
      metadata: { goalCount: goals.length }
    }),
    countMetric(agent, subject, evidenceFromCommitments(agent, commitments), {
      id: "agent.social.commitment_count",
      label: "Agent social commitment count",
      value: commitments.length,
      metadata: {
        commitmentIds: sampleIds(commitments.map((record) => record.id)),
        statuses: countStrings(commitments.map((record) => record.status))
      }
    }),
    countMetric(agent, subject, evidenceFromCommitments(agent, commitments), {
      id: "agent.social.active_commitment_count",
      label: "Agent social active commitment count",
      value: commitments.filter((record) => record.status === "active").length,
      denominator: commitments.length,
      metadata: { commitmentCount: commitments.length }
    }),
    countMetric(agent, subject, evidenceFromCommitments(agent, commitments), {
      id: "agent.social.fulfilled_commitment_count",
      label: "Agent social fulfilled commitment count",
      value: commitments.filter((record) => record.status === "fulfilled").length,
      denominator: commitments.length,
      metadata: { commitmentCount: commitments.length }
    }),
    countMetric(agent, subject, evidenceFromCommitments(agent, commitments), {
      id: "agent.social.broken_commitment_count",
      label: "Agent social broken commitment count",
      value: commitments.filter((record) => record.status === "broken").length,
      denominator: commitments.length,
      metadata: { commitmentCount: commitments.length }
    }),
    ratioMetric(agent, subject, evidenceFromCommitments(agent, commitments), {
      id: "agent.social.evidenced_commitment_rate",
      label: "Agent social evidenced commitment rate",
      value: ratio(evidenceBackedCommitments.length, commitments.length),
      denominator: commitments.length,
      confidence: confidence(commitments.length),
      metadata: {
        evidenceBackedCommitments: evidenceBackedCommitments.length,
        commitmentCount: commitments.length
      }
    }),
    countMetric(agent, subject, evidenceFromCoalitions(agent, coalitions), {
      id: "agent.social.coalition_count",
      label: "Agent social coalition count",
      value: coalitions.length,
      metadata: {
        coalitionIds: sampleIds(coalitions.map((record) => record.id)),
        statuses: countStrings(coalitions.map((record) => record.status))
      }
    }),
    countMetric(agent, subject, evidenceFromCoalitions(agent, coalitions), {
      id: "agent.social.active_coalition_count",
      label: "Agent social active coalition count",
      value: coalitions.filter((record) => record.status === "active").length,
      denominator: coalitions.length,
      metadata: { coalitionCount: coalitions.length }
    }),
    countMetric(agent, subject, evidenceFromCoalitions(agent, coalitions), {
      id: "agent.social.betrayed_coalition_count",
      label: "Agent social betrayed coalition count",
      value: coalitions.filter((record) => record.status === "betrayed").length,
      denominator: coalitions.length,
      metadata: { coalitionCount: coalitions.length }
    }),
    ratioMetric(agent, subject, evidenceFromCoalitions(agent, coalitions), {
      id: "agent.social.evidenced_coalition_rate",
      label: "Agent social evidenced coalition rate",
      value: ratio(evidenceBackedCoalitions.length, coalitions.length),
      denominator: coalitions.length,
      confidence: confidence(coalitions.length),
      metadata: {
        evidenceBackedCoalitions: evidenceBackedCoalitions.length,
        coalitionCount: coalitions.length
      }
    }),
    countMetric(agent, subject, evidenceFromGossip(agent, gossip), {
      id: "agent.social.gossip_count",
      label: "Agent social gossip count",
      value: gossip.length,
      metadata: {
        gossipIds: sampleIds(gossip.map((record) => record.id)),
        subjectIds: sampleIds(gossip.map((record) => record.subjectId)),
        valences: countStrings(gossip.map((record) => record.valence))
      }
    }),
    ratioMetric(agent, subject, evidenceFromGossip(agent, gossip), {
      id: "agent.social.evidenced_gossip_rate",
      label: "Agent social evidenced gossip rate",
      value: ratio(evidenceBackedGossip.length, gossip.length),
      denominator: gossip.length,
      confidence: confidence(gossip.length),
      metadata: {
        evidenceBackedGossip: evidenceBackedGossip.length,
        gossipCount: gossip.length
      }
    }),
    countMetric(agent, subject, evidenceFromNormSanctions(agent, normSanctions), {
      id: "agent.social.norm_sanction_count",
      label: "Agent social norm sanction count",
      value: normSanctions.length,
      metadata: {
        normSanctionIds: sampleIds(normSanctions.map((record) => record.id)),
        normIds: sampleIds(normSanctions.map((record) => record.normId)),
        statuses: countStrings(normSanctions.map((record) => record.status)),
        kinds: countStrings(normSanctions.map((record) => record.kind))
      }
    }),
    countMetric(agent, subject, evidenceFromNormSanctions(agent, normSanctions), {
      id: "agent.social.applied_norm_sanction_count",
      label: "Agent social applied norm sanction count",
      value: normSanctions.filter((record) => record.status === "applied").length,
      denominator: normSanctions.length,
      metadata: { normSanctionCount: normSanctions.length }
    }),
    ratioMetric(agent, subject, evidenceFromNormSanctions(agent, normSanctions), {
      id: "agent.social.evidenced_norm_sanction_rate",
      label: "Agent social evidenced norm sanction rate",
      value: ratio(evidenceBackedNormSanctions.length, normSanctions.length),
      denominator: normSanctions.length,
      confidence: confidence(normSanctions.length),
      metadata: {
        evidenceBackedNormSanctions: evidenceBackedNormSanctions.length,
        normSanctionCount: normSanctions.length
      }
    }),
    countMetric(agent, subject, evidenceFromTrustRepairs(agent, trustRepairs), {
      id: "agent.social.trust_repair_count",
      label: "Agent social trust repair record count",
      value: trustRepairs.length,
      metadata: {
        trustRepairIds: sampleIds(trustRepairs.map((record) => record.id)),
        targetIds: sampleIds(trustRepairs.map((record) => record.targetId)),
        statuses: countStrings(trustRepairs.map((record) => record.status)),
        kinds: countStrings(trustRepairs.map((record) => record.kind))
      }
    }),
    countMetric(agent, subject, evidenceFromTrustRepairs(agent, trustRepairs), {
      id: "agent.social.accepted_trust_repair_count",
      label: "Agent social accepted trust repair record count",
      value: trustRepairs.filter((record) => record.status === "accepted").length,
      denominator: trustRepairs.length,
      metadata: { trustRepairCount: trustRepairs.length }
    }),
    ratioMetric(agent, subject, evidenceFromTrustRepairs(agent, trustRepairs), {
      id: "agent.social.evidenced_trust_repair_rate",
      label: "Agent social evidenced trust repair record rate",
      value: ratio(evidenceBackedTrustRepairs.length, trustRepairs.length),
      denominator: trustRepairs.length,
      confidence: confidence(trustRepairs.length),
      metadata: {
        evidenceBackedTrustRepairs: evidenceBackedTrustRepairs.length,
        trustRepairCount: trustRepairs.length
      }
    }),
    countMetric(agent, subject, evidenceFromBetrayals(agent, betrayals), {
      id: "agent.social.betrayal_count",
      label: "Agent social betrayal record count",
      value: betrayals.length,
      metadata: {
        betrayalIds: sampleIds(betrayals.map((record) => record.id)),
        targetIds: sampleIds(betrayals.map((record) => record.targetId)),
        statuses: countStrings(betrayals.map((record) => record.status)),
        kinds: countStrings(betrayals.map((record) => record.kind))
      }
    }),
    countMetric(agent, subject, evidenceFromBetrayals(agent, betrayals), {
      id: "agent.social.confirmed_betrayal_count",
      label: "Agent social status-confirmed betrayal record count",
      value: betrayals.filter((record) => record.status === "confirmed").length,
      denominator: betrayals.length,
      metadata: {
        betrayalCount: betrayals.length,
        statusSource: "AgentSocialState.betrayals.records.status",
        postgameTruthUsed: false,
        causalClaim: false
      }
    }),
    ratioMetric(agent, subject, evidenceFromBetrayals(agent, betrayals), {
      id: "agent.social.evidenced_betrayal_rate",
      label: "Agent social evidenced betrayal record rate",
      value: ratio(evidenceBackedBetrayals.length, betrayals.length),
      denominator: betrayals.length,
      confidence: confidence(betrayals.length),
      metadata: {
        evidenceBackedBetrayals: evidenceBackedBetrayals.length,
        betrayalCount: betrayals.length
      }
    })
  ];
}

function dynamicsMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const relationshipEdges = Object.values(social.relationships.edges);
  const reputationRecords = Object.values(social.reputation.records);
  const norms = Object.values(social.norms.norms);
  const messageEntries = social.memory.entries.filter((entry) => entry.kind === "message");
  const influenceEdges = relationshipEdges.filter((edge) => edge.influence > 0);
  const coordinationMessages = messageEntries.filter((entry) => isCoordinationMessage(agent, entry));
  const coalitionSignals = coalitionSignalRecords(relationshipEdges, reputationRecords);
  const reputationWithEvidence = reputationRecords.filter((record) => record.evidenceRefs.length > 0);
  const normPressureRecords = norms.filter(isNormPressureRecord);
  const resolvedNorms = norms.filter((norm) => norm.status === "fulfilled" || norm.status === "violated" || norm.status === "expired");

  return [
    dynamicsCountMetric(agent, subject, evidenceFromRelationships(agent, influenceEdges), {
      id: "agent.social.influence_edge_count",
      label: "Agent social influence edge count",
      value: influenceEdges.length,
      denominator: relationshipEdges.length,
      metadata: {
        relationshipEdges: relationshipEdges.length,
        targetIds: sampleIds(influenceEdges.map((edge) => edge.targetId))
      }
    }),
    dynamicsCountMetric(agent, subject, evidenceFromMemories(agent, coordinationMessages), {
      id: "agent.social.coordination_message_count",
      label: "Agent social coordination message count",
      value: coordinationMessages.length,
      denominator: messageEntries.length,
      metadata: {
        messageEntries: messageEntries.length,
        messageSeqs: coordinationMessages.map((entry) => entry.seq).slice(0, 20)
      }
    }),
    dynamicsCountMetric(agent, subject, evidenceFromCoalitionSignals(agent, coalitionSignals), {
      id: "agent.social.coalition_signal_count",
      label: "Agent social coalition signal count",
      value: coalitionSignals.length,
      denominator: relationshipEdges.length + reputationRecords.length,
      metadata: {
        relationshipSignals: coalitionSignals.filter((record) => record.kind === "relationship").length,
        reputationSignals: coalitionSignals.filter((record) => record.kind === "reputation").length,
        subjectIds: sampleIds(coalitionSignals.map((record) => record.subjectId))
      }
    }),
    dynamicsRatioMetric(agent, subject, evidenceFromReputation(agent, reputationRecords), {
      id: "agent.social.reputation_evidence_rate",
      label: "Agent social reputation evidence rate",
      value: ratio(reputationWithEvidence.length, reputationRecords.length),
      denominator: reputationRecords.length,
      confidence: confidence(reputationRecords.length),
      metadata: {
        reputationRecords: reputationRecords.length,
        evidenceBackedRecords: reputationWithEvidence.length
      }
    }),
    dynamicsCountMetric(agent, subject, evidenceFromNorms(agent, normPressureRecords), {
      id: "agent.social.norm_pressure_count",
      label: "Agent social norm pressure count",
      value: normPressureRecords.length,
      denominator: norms.length,
      metadata: {
        normCount: norms.length,
        normIds: sampleIds(normPressureRecords.map((norm) => norm.id))
      }
    }),
    dynamicsRatioMetric(agent, subject, evidenceFromNorms(agent, norms), {
      id: "agent.social.norm_resolution_rate",
      label: "Agent social norm resolution rate",
      value: ratio(resolvedNorms.length, norms.length),
      denominator: norms.length,
      confidence: confidence(norms.length),
      metadata: {
        normCount: norms.length,
        resolvedNorms: resolvedNorms.length
      }
    })
  ];
}

function commitmentCoalitionAssociationMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const commitments = Object.values(social.commitments?.records ?? {});
  const coalitions = Object.values(social.coalitions?.records ?? {});
  const pairs = commitmentCoalitionPairs(commitments, coalitions);
  const evaluablePairs = pairs.filter((pair) => pair.evaluable);
  const associatedPairs = evaluablePairs.filter((pair) => pair.associationKinds.length > 0);
  const allPairEvidence = evidenceFromCommitmentCoalitionPairs(agent, evaluablePairs);
  const associatedPairEvidence = evidenceFromCommitmentCoalitionPairs(agent, associatedPairs);
  const commonMetadata = {
    commitmentCount: commitments.length,
    coalitionCount: coalitions.length,
    totalPairs: pairs.length,
    evaluablePairs: evaluablePairs.length,
    associatedPairs: associatedPairs.length,
    samplePairs: sampleAssociationPairs(associatedPairs)
  };

  return [
    associationCountMetric(agent, subject, associatedPairEvidence, {
      id: "agent.social.commitment_coalition_association_count",
      label: "Agent social commitment-coalition association count",
      value: associatedPairs.length,
      denominator: evaluablePairs.length,
      metadata: commonMetadata
    }),
    associationRatioMetric(agent, subject, associatedPairEvidence, {
      id: "agent.social.commitment_coalition_association_rate",
      label: "Agent social commitment-coalition association rate",
      value: ratio(associatedPairs.length, evaluablePairs.length),
      denominator: evaluablePairs.length,
      confidence: confidence(evaluablePairs.length),
      metadata: commonMetadata
    }),
    associationRatioMetric(agent, subject, allPairEvidence, {
      id: "agent.social.commitment_coalition_evaluable_pair_rate",
      label: "Agent social commitment-coalition evaluable pair rate",
      value: ratio(evaluablePairs.length, pairs.length),
      denominator: pairs.length,
      confidence: confidence(pairs.length),
      metadata: commonMetadata
    })
  ];
}

function commitmentCoalitionLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const commitments = Object.values(social.commitments?.records ?? {});
  const coalitions = Object.values(social.coalitions?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const commitmentRecords = commitments.map((record) => evaluateCommitmentLifecycleRecord(record, journalEntries));
  const coalitionRecords = coalitions.map((record) => evaluateCoalitionLifecycleRecord(record, journalEntries));
  const evaluableCommitments = commitmentRecords.filter((record) => record.evaluable);
  const associatedCommitments = evaluableCommitments.filter((record) => record.associated);
  const evaluableCoalitions = coalitionRecords.filter((record) => record.evaluable);
  const associatedCoalitions = evaluableCoalitions.filter((record) => record.associated);
  const commitmentMetadata = lifecycleMetadata("commitment_status_journal_temporal_association", {
    recordCount: commitmentRecords.length,
    evaluableRecords: evaluableCommitments.length,
    associatedRecords: associatedCommitments.length,
    missingCreationRecords: commitmentRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: commitmentRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterStatusUpdateRecords: evaluableCommitments.filter((record) => record.noLaterLifecycle).length,
    sampleAssociatedRecords: sampleLifecycleRecords(associatedCommitments)
  });
  const coalitionMetadata = lifecycleMetadata("coalition_lifecycle_journal_temporal_association", {
    recordCount: coalitionRecords.length,
    evaluableRecords: evaluableCoalitions.length,
    associatedRecords: associatedCoalitions.length,
    missingCreationRecords: coalitionRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: coalitionRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterLifecycleEvidenceRecords: evaluableCoalitions.filter((record) => record.noLaterLifecycle).length,
    lifecycleEvidenceKinds: ["coordination", "betrayal", "dissolution"],
    sampleAssociatedRecords: sampleLifecycleRecords(associatedCoalitions)
  });

  return [
    lifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedCommitments), {
      id: "agent.social.commitment_status_temporal_association_count",
      label: "Agent social commitment status temporal association count",
      value: associatedCommitments.length,
      denominator: evaluableCommitments.length,
      metadata: commitmentMetadata
    }),
    lifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedCommitments), {
      id: "agent.social.commitment_status_temporal_association_rate",
      label: "Agent social commitment status temporal association rate",
      value: ratio(associatedCommitments.length, evaluableCommitments.length),
      denominator: evaluableCommitments.length,
      confidence: confidence(evaluableCommitments.length),
      aggregation: "ratio",
      metadata: commitmentMetadata
    }),
    lifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, commitmentRecords), {
      id: "agent.social.commitment_status_temporal_evaluable_record_rate",
      label: "Agent social commitment status temporal evaluable record rate",
      value: ratio(evaluableCommitments.length, commitmentRecords.length),
      denominator: commitmentRecords.length,
      confidence: confidence(commitmentRecords.length),
      aggregation: "coverage_ratio",
      metadata: commitmentMetadata
    }),
    lifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedCoalitions), {
      id: "agent.social.coalition_lifecycle_temporal_association_count",
      label: "Agent social coalition lifecycle temporal association count",
      value: associatedCoalitions.length,
      denominator: evaluableCoalitions.length,
      metadata: coalitionMetadata
    }),
    lifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedCoalitions), {
      id: "agent.social.coalition_lifecycle_temporal_association_rate",
      label: "Agent social coalition lifecycle temporal association rate",
      value: ratio(associatedCoalitions.length, evaluableCoalitions.length),
      denominator: evaluableCoalitions.length,
      confidence: confidence(evaluableCoalitions.length),
      aggregation: "ratio",
      metadata: coalitionMetadata
    }),
    lifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, coalitionRecords), {
      id: "agent.social.coalition_lifecycle_temporal_evaluable_record_rate",
      label: "Agent social coalition lifecycle temporal evaluable record rate",
      value: ratio(evaluableCoalitions.length, coalitionRecords.length),
      denominator: coalitionRecords.length,
      confidence: confidence(coalitionRecords.length),
      aggregation: "coverage_ratio",
      metadata: coalitionMetadata
    })
  ];
}

function normSanctionLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const norms = Object.values(social.norms.norms);
  const normSanctions = Object.values(social.normSanctions?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const normRecords = norms.map((record) => evaluateNormLifecycleRecord(record, journalEntries));
  const normSanctionRecords = normSanctions.map((record) => evaluateNormSanctionLifecycleRecord(record, journalEntries));
  const evaluableNorms = normRecords.filter((record) => record.evaluable);
  const associatedNorms = evaluableNorms.filter((record) => record.associated);
  const evaluableNormSanctions = normSanctionRecords.filter((record) => record.evaluable);
  const associatedNormSanctions = evaluableNormSanctions.filter((record) => record.associated);
  const normMetadata = lifecycleMetadata("norm_status_journal_temporal_association", {
    recordCount: normRecords.length,
    evaluableRecords: evaluableNorms.length,
    associatedRecords: associatedNorms.length,
    missingCreationRecords: normRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: normRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterStatusUpdateRecords: evaluableNorms.filter((record) => record.noLaterLifecycle).length,
    sampleAssociatedRecords: sampleLifecycleRecords(associatedNorms)
  });
  const normSanctionMetadata = lifecycleMetadata("norm_sanction_status_journal_temporal_association", {
    recordCount: normSanctionRecords.length,
    evaluableRecords: evaluableNormSanctions.length,
    associatedRecords: associatedNormSanctions.length,
    missingCreationRecords: normSanctionRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: normSanctionRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterStatusUpdateRecords: evaluableNormSanctions.filter((record) => record.noLaterLifecycle).length,
    sampleAssociatedRecords: sampleLifecycleRecords(associatedNormSanctions)
  });

  return [
    normSanctionLifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedNorms), {
      id: "agent.social.norm_status_temporal_association_count",
      label: "Agent social norm status temporal association count",
      value: associatedNorms.length,
      denominator: evaluableNorms.length,
      metadata: normMetadata
    }),
    normSanctionLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedNorms), {
      id: "agent.social.norm_status_temporal_association_rate",
      label: "Agent social norm status temporal association rate",
      value: ratio(associatedNorms.length, evaluableNorms.length),
      denominator: evaluableNorms.length,
      confidence: confidence(evaluableNorms.length),
      aggregation: "ratio",
      metadata: normMetadata
    }),
    normSanctionLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, normRecords), {
      id: "agent.social.norm_status_temporal_evaluable_record_rate",
      label: "Agent social norm status temporal evaluable record rate",
      value: ratio(evaluableNorms.length, normRecords.length),
      denominator: normRecords.length,
      confidence: confidence(normRecords.length),
      aggregation: "coverage_ratio",
      metadata: normMetadata
    }),
    normSanctionLifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedNormSanctions), {
      id: "agent.social.norm_sanction_status_temporal_association_count",
      label: "Agent social norm sanction status temporal association count",
      value: associatedNormSanctions.length,
      denominator: evaluableNormSanctions.length,
      metadata: normSanctionMetadata
    }),
    normSanctionLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedNormSanctions), {
      id: "agent.social.norm_sanction_status_temporal_association_rate",
      label: "Agent social norm sanction status temporal association rate",
      value: ratio(associatedNormSanctions.length, evaluableNormSanctions.length),
      denominator: evaluableNormSanctions.length,
      confidence: confidence(evaluableNormSanctions.length),
      aggregation: "ratio",
      metadata: normSanctionMetadata
    }),
    normSanctionLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, normSanctionRecords), {
      id: "agent.social.norm_sanction_status_temporal_evaluable_record_rate",
      label: "Agent social norm sanction status temporal evaluable record rate",
      value: ratio(evaluableNormSanctions.length, normSanctionRecords.length),
      denominator: normSanctionRecords.length,
      confidence: confidence(normSanctionRecords.length),
      aggregation: "coverage_ratio",
      metadata: normSanctionMetadata
    })
  ];
}

function gossipExposureTemporalMetricsForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  totalExposureRecords: number
): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const gossipRecords = Object.values(social.gossip?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const evaluatedRecords = gossipRecords.map((record) => evaluateGossipExposureRecord(record, journalEntries, exposureRecords, totalExposureRecords));
  const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
  const associatedRecords = evaluableRecords.filter((record) => record.associated);
  const metadata = gossipExposureMetadata({
    recordCount: evaluatedRecords.length,
    evaluableRecords: evaluableRecords.length,
    associatedRecords: associatedRecords.length,
    missingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
    missingMessageEvidenceRecords: evaluatedRecords.filter((record) => record.missingMessageEvidence).length,
    missingScopedExposureRecords: evaluatedRecords.filter((record) => record.missingScopedExposure).length,
    ambiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
    sameTurnIngestionRecords: evaluableRecords.filter((record) => record.sameTurnIngestion).length,
    noLaterCreationRecords: evaluableRecords.filter((record) => record.noLaterCreation).length,
    totalExposureRecords,
    observerExposureRecords: exposureRecords.length,
    sampleAssociatedRecords: sampleGossipExposureRecords(associatedRecords)
  });

  return [
    gossipExposureTemporalCountMetric(agent, subject, evidenceFromGossipExposureRecords(agent, associatedRecords), {
      id: "agent.social.gossip_exposure_temporal_association_count",
      label: "Agent social gossip exposure temporal association count",
      value: associatedRecords.length,
      denominator: evaluableRecords.length,
      metadata
    }),
    gossipExposureTemporalRatioMetric(agent, subject, evidenceFromGossipExposureRecords(agent, associatedRecords), {
      id: "agent.social.gossip_exposure_temporal_association_rate",
      label: "Agent social gossip exposure temporal association rate",
      value: ratio(associatedRecords.length, evaluableRecords.length),
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    }),
    gossipExposureTemporalRatioMetric(agent, subject, evidenceFromGossipExposureRecords(agent, evaluatedRecords), {
      id: "agent.social.gossip_exposure_temporal_evaluable_record_rate",
      label: "Agent social gossip exposure temporal evaluable record rate",
      value: ratio(evaluableRecords.length, evaluatedRecords.length),
      denominator: evaluatedRecords.length,
      confidence: confidence(evaluatedRecords.length),
      aggregation: "coverage_ratio",
      metadata
    })
  ];
}

function trustRepairLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairLifecycleRecord(record, journalEntries));
  const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
  const associatedRecords = evaluableRecords.filter((record) => record.associated);
  const metadata = lifecycleMetadata("trust_repair_status_journal_temporal_association", {
    recordCount: evaluatedRecords.length,
    evaluableRecords: evaluableRecords.length,
    associatedRecords: associatedRecords.length,
    missingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterStatusUpdateRecords: evaluableRecords.filter((record) => record.noLaterLifecycle).length,
    sampleAssociatedRecords: sampleLifecycleRecords(associatedRecords)
  });

  return [
    trustRepairLifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_status_temporal_association_count",
      label: "Agent social trust repair status temporal association count",
      value: associatedRecords.length,
      denominator: evaluableRecords.length,
      metadata
    }),
    trustRepairLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_status_temporal_association_rate",
      label: "Agent social trust repair status temporal association rate",
      value: ratio(associatedRecords.length, evaluableRecords.length),
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    }),
    trustRepairLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, evaluatedRecords), {
      id: "agent.social.trust_repair_status_temporal_evaluable_record_rate",
      label: "Agent social trust repair status temporal evaluable record rate",
      value: ratio(evaluableRecords.length, evaluatedRecords.length),
      denominator: evaluatedRecords.length,
      confidence: confidence(evaluatedRecords.length),
      aggregation: "coverage_ratio",
      metadata
    })
  ];
}

function trustRepairRelationshipTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairRelationshipRecord(record, journalEntries));
  const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
  const associatedRecords = evaluableRecords.filter((record) => record.associated);
  const metadata = trustRepairJournalMutationMetadata("trust_repair_relationship_journal_temporal_association", {
    mutationSource: "AgentSocialState.journal.entries:relationship.updated",
    relationshipDimensionWhitelist: RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS,
    relationshipDimensions: mutationDimensions(associatedRecords),
    recordCount: evaluatedRecords.length,
    evaluableRecords: evaluableRecords.length,
    associatedRecords: associatedRecords.length,
    missingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
    sameTurnMutationRecords: evaluableRecords.filter((record) => record.sameTurnMutation).length,
    noLaterRelationshipUpdateRecords: evaluableRecords.filter((record) => record.noLaterMutation).length,
    sampleAssociatedRecords: sampleJournalMutationRecords(associatedRecords)
  });

  return [
    trustRepairRelationshipTemporalCountMetric(agent, subject, evidenceFromJournalMutationRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_relationship_temporal_association_count",
      label: "Agent social trust repair relationship temporal association count",
      value: associatedRecords.length,
      denominator: evaluableRecords.length,
      metadata
    }),
    trustRepairRelationshipTemporalRatioMetric(agent, subject, evidenceFromJournalMutationRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_relationship_temporal_association_rate",
      label: "Agent social trust repair relationship temporal association rate",
      value: ratio(associatedRecords.length, evaluableRecords.length),
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    }),
    trustRepairRelationshipTemporalRatioMetric(agent, subject, evidenceFromJournalMutationRecords(agent, evaluatedRecords), {
      id: "agent.social.trust_repair_relationship_temporal_evaluable_record_rate",
      label: "Agent social trust repair relationship temporal evaluable record rate",
      value: ratio(evaluableRecords.length, evaluatedRecords.length),
      denominator: evaluatedRecords.length,
      confidence: confidence(evaluatedRecords.length),
      aggregation: "coverage_ratio",
      metadata
    })
  ];
}

function trustRepairReputationTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairReputationRecord(record, journalEntries));
  const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
  const associatedRecords = evaluableRecords.filter((record) => record.associated);
  const metadata = trustRepairJournalMutationMetadata("trust_repair_reputation_journal_temporal_association", {
    mutationSource: "AgentSocialState.journal.entries:reputation.updated",
    reputationDimensionWhitelist: REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS,
    reputationDimensions: mutationDimensions(associatedRecords),
    recordCount: evaluatedRecords.length,
    evaluableRecords: evaluableRecords.length,
    associatedRecords: associatedRecords.length,
    missingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
    sameTurnMutationRecords: evaluableRecords.filter((record) => record.sameTurnMutation).length,
    noLaterReputationUpdateRecords: evaluableRecords.filter((record) => record.noLaterMutation).length,
    sampleAssociatedRecords: sampleJournalMutationRecords(associatedRecords)
  });

  return [
    trustRepairReputationTemporalCountMetric(agent, subject, evidenceFromJournalMutationRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_reputation_temporal_association_count",
      label: "Agent social trust repair reputation temporal association count",
      value: associatedRecords.length,
      denominator: evaluableRecords.length,
      metadata
    }),
    trustRepairReputationTemporalRatioMetric(agent, subject, evidenceFromJournalMutationRecords(agent, associatedRecords), {
      id: "agent.social.trust_repair_reputation_temporal_association_rate",
      label: "Agent social trust repair reputation temporal association rate",
      value: ratio(associatedRecords.length, evaluableRecords.length),
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    }),
    trustRepairReputationTemporalRatioMetric(agent, subject, evidenceFromJournalMutationRecords(agent, evaluatedRecords), {
      id: "agent.social.trust_repair_reputation_temporal_evaluable_record_rate",
      label: "Agent social trust repair reputation temporal evaluable record rate",
      value: ratio(evaluableRecords.length, evaluatedRecords.length),
      denominator: evaluatedRecords.length,
      confidence: confidence(evaluatedRecords.length),
      aggregation: "coverage_ratio",
      metadata
    })
  ];
}

function betrayalLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
  const social = agent.social;
  if (!social) return [];

  const subject = socialSubject(agent);
  const betrayals = Object.values(social.betrayals?.records ?? {});
  const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
  const evaluatedRecords = betrayals.map((record) => evaluateBetrayalLifecycleRecord(record, journalEntries));
  const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
  const associatedRecords = evaluableRecords.filter((record) => record.associated);
  const metadata = lifecycleMetadata("betrayal_lifecycle_journal_temporal_association", {
    betrayalSource: "AgentSocialState.betrayals.records",
    mutationSource: "AgentSocialState.journal.entries:betrayal.evidence.recorded",
    recordCount: evaluatedRecords.length,
    evaluableRecords: evaluableRecords.length,
    associatedRecords: associatedRecords.length,
    missingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
    ambiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
    noLaterLifecycleEvidenceRecords: evaluableRecords.filter((record) => record.noLaterLifecycle).length,
    lifecycleEvidenceKinds: ["allegation", "corroboration", "contest", "repair", "outcome"],
    sampleAssociatedRecords: sampleLifecycleRecords(associatedRecords)
  });

  return [
    betrayalLifecycleCountMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedRecords), {
      id: "agent.social.betrayal_lifecycle_temporal_association_count",
      label: "Agent social betrayal lifecycle temporal association count",
      value: associatedRecords.length,
      denominator: evaluableRecords.length,
      metadata
    }),
    betrayalLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, associatedRecords), {
      id: "agent.social.betrayal_lifecycle_temporal_association_rate",
      label: "Agent social betrayal lifecycle temporal association rate",
      value: ratio(associatedRecords.length, evaluableRecords.length),
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    }),
    betrayalLifecycleRatioMetric(agent, subject, evidenceFromLifecycleRecords(agent, evaluatedRecords), {
      id: "agent.social.betrayal_lifecycle_temporal_evaluable_record_rate",
      label: "Agent social betrayal lifecycle temporal evaluable record rate",
      value: ratio(evaluableRecords.length, evaluatedRecords.length),
      denominator: evaluatedRecords.length,
      confidence: confidence(evaluatedRecords.length),
      aggregation: "coverage_ratio",
      metadata
    })
  ];
}

function exposureMetricsForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  episodeTotals: { totalExposureRecords: number; publicExposureRecords: number; uniqueSourcesAcrossEpisode: number }
): HarnessMetricRecord[] {
  const subject = socialSubject(agent);
  const publicExposures = exposureRecords.filter((record) => record.visibility === "public");
  const uniqueSourceIdSet = new Set(exposureRecords.map((record) => record.sourceId));
  const uniqueSourceIds = sampleIds([...uniqueSourceIdSet]);
  const commonMetadata = {
    exposureRecords: exposureRecords.length,
    publicExposureRecords: publicExposures.length,
    sourceIds: uniqueSourceIds,
    messageIds: sampleIds(exposureRecords.map((record) => record.messageId)),
    messageSeqs: exposureRecords.map((record) => record.messageSeq).slice(0, 20),
    channelIds: sampleIds([...new Set(exposureRecords.map((record) => record.channelId))]),
    actionKinds: sampleIds([...new Set(exposureRecords.map((record) => record.observedAtActionKind))]),
    visibilityCounts: visibilityCounts(exposureRecords)
  };

  return [
    dynamicsCountMetric(agent, subject, evidenceFromExposureRecords(agent, exposureRecords), {
      id: "agent.social.exposure_received_count",
      label: "Agent social exposure received count",
      value: exposureRecords.length,
      denominator: episodeTotals.totalExposureRecords,
      metadata: commonMetadata
    }),
    dynamicsCountMetric(agent, subject, evidenceFromExposureRecords(agent, publicExposures), {
      id: "agent.social.public_exposure_received_count",
      label: "Agent social public exposure received count",
      value: publicExposures.length,
      denominator: episodeTotals.publicExposureRecords,
      metadata: {
        ...commonMetadata,
        publicMessageSeqs: publicExposures.map((record) => record.messageSeq).slice(0, 20)
      }
    }),
    dynamicsCountMetric(agent, subject, evidenceFromExposureRecords(agent, exposureRecords), {
      id: "agent.social.unique_exposure_source_count",
      label: "Agent social unique exposure source count",
      value: uniqueSourceIdSet.size,
      denominator: episodeTotals.uniqueSourcesAcrossEpisode,
      metadata: commonMetadata
    })
  ];
}

function summarizeSocialState(agents: SocialAgentSnapshot[]): SocialStateEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [agent.social] : []));
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    memoryEntries: states.reduce((sum, state) => sum + state.memory.entries.length, 0),
    reflectionEntries: states.reduce((sum, state) => sum + state.memory.entries.filter((entry) => entry.kind === "reflection").length, 0),
    outcomeEntries: states.reduce((sum, state) => sum + state.memory.entries.filter((entry) => entry.kind === "outcome").length, 0),
    beliefClaims: states.reduce((sum, state) => sum + Object.keys(state.beliefs.claims).length, 0),
    relationshipEdges: states.reduce((sum, state) => sum + Object.keys(state.relationships.edges).length, 0),
    reputationRecords: states.reduce((sum, state) => sum + Object.keys(state.reputation.records).length, 0),
    norms: states.reduce((sum, state) => sum + Object.keys(state.norms.norms).length, 0),
    goals: states.reduce((sum, state) => sum + state.goals.goals.length, 0),
    commitments: states.reduce((sum, state) => sum + Object.keys(state.commitments?.records ?? {}).length, 0),
    coalitions: states.reduce((sum, state) => sum + Object.keys(state.coalitions?.records ?? {}).length, 0),
    gossip: states.reduce((sum, state) => sum + Object.keys(state.gossip?.records ?? {}).length, 0),
    normSanctions: states.reduce((sum, state) => sum + Object.keys(state.normSanctions?.records ?? {}).length, 0),
    trustRepairs: states.reduce((sum, state) => sum + Object.keys(state.trustRepairs?.records ?? {}).length, 0),
    betrayals: states.reduce((sum, state) => sum + Object.keys(state.betrayals?.records ?? {}).length, 0),
    journalEntries: states.reduce((sum, state) => sum + (state.journal?.entries.length ?? 0), 0),
    agentsWithJournal: states.filter((state) => (state.journal?.entries.length ?? 0) > 0).length
  };
}

function summarizeSocialDynamics(agents: SocialAgentSnapshot[], socialEpisode?: unknown): SocialDynamicsEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ agent, social: agent.social }] : []));
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    influenceEdges: states.reduce((sum, { social }) => sum + Object.values(social.relationships.edges).filter((edge) => edge.influence > 0).length, 0),
    coordinationMessages: states.reduce(
      (sum, { agent, social }) => sum + social.memory.entries.filter((entry) => entry.kind === "message" && isCoordinationMessage(agent, entry)).length,
      0
    ),
    coalitionSignals: states.reduce(
      (sum, { social }) => sum + coalitionSignalRecords(Object.values(social.relationships.edges), Object.values(social.reputation.records)).length,
      0
    ),
    exposureRecords: exposureRecords.length,
    publicExposureRecords: exposureRecords.filter((record) => record.visibility === "public").length,
    reputationRecords: states.reduce((sum, { social }) => sum + Object.keys(social.reputation.records).length, 0),
    normPressureRecords: states.reduce((sum, { social }) => sum + Object.values(social.norms.norms).filter(isNormPressureRecord).length, 0)
  };
}

function summarizeSocialFactIngestEvidence(agents: SocialAgentSnapshot[], socialEpisode?: unknown): SocialFactIngestEvidenceEvaluation {
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  const recordsByObserver = groupExposureRecordsByObserver(exposureRecords);
  const messageIndex = socialMessageIndex(messagesFromSocialEpisode(socialEpisode));
  const aggregate = agents.map((agent) => {
    const evaluations = evaluateSocialFactIngestEvidenceForAgent(agent, recordsByObserver.get(socialAgentId(agent)) ?? [], messageIndex);
    const byKind = (kind: SocialFactIngestCandidateKind) => evaluations.filter((item) => item.candidate.kind === kind);
    const commitment = byKind("commitment");
    const coalition = byKind("coalition");
    const relationship = byKind("relationship");
    const reputation = byKind("reputation");
    return {
      hasSocial: Boolean(agent.social),
      hasJournal: (agent.social?.journal?.entries.length ?? 0) > 0,
      hasExposure: (recordsByObserver.get(socialAgentId(agent))?.length ?? 0) > 0,
      commitmentSpeechActCandidates: commitment.length,
      commitmentSpeechActLinkedCandidates: commitment.filter((item) => item.linked).length,
      commitmentSpeechActMissingMutationCandidates: commitment.filter((item) => item.missingMutation).length,
      coalitionSpeechActCandidates: coalition.length,
      coalitionSpeechActLinkedCandidates: coalition.filter((item) => item.linked).length,
      coalitionSpeechActMissingMutationCandidates: coalition.filter((item) => item.missingMutation).length,
      relationshipFactCandidates: relationship.length,
      relationshipFactLinkedCandidates: relationship.filter((item) => item.linked).length,
      relationshipFactMissingMutationCandidates: relationship.filter((item) => item.missingMutation).length,
      reputationFactCandidates: reputation.length,
      reputationFactLinkedCandidates: reputation.filter((item) => item.linked).length,
      reputationFactMissingMutationCandidates: reputation.filter((item) => item.missingMutation).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: aggregate.filter((item) => item.hasSocial).length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    agentsWithExposureRecords: aggregate.filter((item) => item.hasExposure).length,
    exposureRecords: exposureRecords.length,
    commitmentSpeechActCandidates: aggregate.reduce((sum, item) => sum + item.commitmentSpeechActCandidates, 0),
    commitmentSpeechActLinkedCandidates: aggregate.reduce((sum, item) => sum + item.commitmentSpeechActLinkedCandidates, 0),
    commitmentSpeechActMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.commitmentSpeechActMissingMutationCandidates, 0),
    coalitionSpeechActCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActCandidates, 0),
    coalitionSpeechActLinkedCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActLinkedCandidates, 0),
    coalitionSpeechActMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActMissingMutationCandidates, 0),
    relationshipFactCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactCandidates, 0),
    relationshipFactLinkedCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactLinkedCandidates, 0),
    relationshipFactMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactMissingMutationCandidates, 0),
    reputationFactCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactCandidates, 0),
    reputationFactLinkedCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactLinkedCandidates, 0),
    reputationFactMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactMissingMutationCandidates, 0)
  };
}

function summarizeCommitmentCoalitionAssociations(agents: SocialAgentSnapshot[]): CommitmentCoalitionAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const commitments = Object.values(social.commitments?.records ?? {});
    const coalitions = Object.values(social.coalitions?.records ?? {});
    const pairs = commitmentCoalitionPairs(commitments, coalitions);
    const evaluablePairs = pairs.filter((pair) => pair.evaluable);
    const associatedPairs = evaluablePairs.filter((pair) => pair.associationKinds.length > 0);
    return {
      commitments: commitments.length,
      coalitions: coalitions.length,
      totalPairs: pairs.length,
      evaluablePairs: evaluablePairs.length,
      associatedPairs: associatedPairs.length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    commitments: aggregate.reduce((sum, item) => sum + item.commitments, 0),
    coalitions: aggregate.reduce((sum, item) => sum + item.coalitions, 0),
    totalPairs: aggregate.reduce((sum, item) => sum + item.totalPairs, 0),
    evaluablePairs: aggregate.reduce((sum, item) => sum + item.evaluablePairs, 0),
    associatedPairs: aggregate.reduce((sum, item) => sum + item.associatedPairs, 0)
  };
}

function summarizeCommitmentCoalitionLifecycleTemporalAssociations(
  agents: SocialAgentSnapshot[]
): CommitmentCoalitionLifecycleTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const commitments = Object.values(social.commitments?.records ?? {});
    const coalitions = Object.values(social.coalitions?.records ?? {});
    const commitmentRecords = commitments.map((record) => evaluateCommitmentLifecycleRecord(record, journalEntries));
    const coalitionRecords = coalitions.map((record) => evaluateCoalitionLifecycleRecord(record, journalEntries));
    const evaluableCommitments = commitmentRecords.filter((record) => record.evaluable);
    const evaluableCoalitions = coalitionRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      commitments: commitments.length,
      commitmentEvaluableRecords: evaluableCommitments.length,
      commitmentAssociatedRecords: evaluableCommitments.filter((record) => record.associated).length,
      commitmentMissingCreationRecords: commitmentRecords.filter((record) => record.missingCreation).length,
      commitmentAmbiguousOrderingRecords: commitmentRecords.filter((record) => record.ambiguousOrdering).length,
      commitmentNoLaterStatusUpdateRecords: evaluableCommitments.filter((record) => record.noLaterLifecycle).length,
      coalitions: coalitions.length,
      coalitionEvaluableRecords: evaluableCoalitions.length,
      coalitionAssociatedRecords: evaluableCoalitions.filter((record) => record.associated).length,
      coalitionMissingCreationRecords: coalitionRecords.filter((record) => record.missingCreation).length,
      coalitionAmbiguousOrderingRecords: coalitionRecords.filter((record) => record.ambiguousOrdering).length,
      coalitionNoLaterLifecycleEvidenceRecords: evaluableCoalitions.filter((record) => record.noLaterLifecycle).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    commitments: aggregate.reduce((sum, item) => sum + item.commitments, 0),
    commitmentEvaluableRecords: aggregate.reduce((sum, item) => sum + item.commitmentEvaluableRecords, 0),
    commitmentAssociatedRecords: aggregate.reduce((sum, item) => sum + item.commitmentAssociatedRecords, 0),
    commitmentMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.commitmentMissingCreationRecords, 0),
    commitmentAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.commitmentAmbiguousOrderingRecords, 0),
    commitmentNoLaterStatusUpdateRecords: aggregate.reduce((sum, item) => sum + item.commitmentNoLaterStatusUpdateRecords, 0),
    coalitions: aggregate.reduce((sum, item) => sum + item.coalitions, 0),
    coalitionEvaluableRecords: aggregate.reduce((sum, item) => sum + item.coalitionEvaluableRecords, 0),
    coalitionAssociatedRecords: aggregate.reduce((sum, item) => sum + item.coalitionAssociatedRecords, 0),
    coalitionMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.coalitionMissingCreationRecords, 0),
    coalitionAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.coalitionAmbiguousOrderingRecords, 0),
    coalitionNoLaterLifecycleEvidenceRecords: aggregate.reduce((sum, item) => sum + item.coalitionNoLaterLifecycleEvidenceRecords, 0)
  };
}

function summarizeNormSanctionLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): NormSanctionLifecycleTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const norms = Object.values(social.norms.norms);
    const normSanctions = Object.values(social.normSanctions?.records ?? {});
    const normRecords = norms.map((record) => evaluateNormLifecycleRecord(record, journalEntries));
    const normSanctionRecords = normSanctions.map((record) => evaluateNormSanctionLifecycleRecord(record, journalEntries));
    const evaluableNorms = normRecords.filter((record) => record.evaluable);
    const evaluableNormSanctions = normSanctionRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      norms: norms.length,
      normEvaluableRecords: evaluableNorms.length,
      normAssociatedRecords: evaluableNorms.filter((record) => record.associated).length,
      normMissingCreationRecords: normRecords.filter((record) => record.missingCreation).length,
      normAmbiguousOrderingRecords: normRecords.filter((record) => record.ambiguousOrdering).length,
      normNoLaterStatusUpdateRecords: evaluableNorms.filter((record) => record.noLaterLifecycle).length,
      normSanctions: normSanctions.length,
      normSanctionEvaluableRecords: evaluableNormSanctions.length,
      normSanctionAssociatedRecords: evaluableNormSanctions.filter((record) => record.associated).length,
      normSanctionMissingCreationRecords: normSanctionRecords.filter((record) => record.missingCreation).length,
      normSanctionAmbiguousOrderingRecords: normSanctionRecords.filter((record) => record.ambiguousOrdering).length,
      normSanctionNoLaterStatusUpdateRecords: evaluableNormSanctions.filter((record) => record.noLaterLifecycle).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    norms: aggregate.reduce((sum, item) => sum + item.norms, 0),
    normEvaluableRecords: aggregate.reduce((sum, item) => sum + item.normEvaluableRecords, 0),
    normAssociatedRecords: aggregate.reduce((sum, item) => sum + item.normAssociatedRecords, 0),
    normMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.normMissingCreationRecords, 0),
    normAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.normAmbiguousOrderingRecords, 0),
    normNoLaterStatusUpdateRecords: aggregate.reduce((sum, item) => sum + item.normNoLaterStatusUpdateRecords, 0),
    normSanctions: aggregate.reduce((sum, item) => sum + item.normSanctions, 0),
    normSanctionEvaluableRecords: aggregate.reduce((sum, item) => sum + item.normSanctionEvaluableRecords, 0),
    normSanctionAssociatedRecords: aggregate.reduce((sum, item) => sum + item.normSanctionAssociatedRecords, 0),
    normSanctionMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.normSanctionMissingCreationRecords, 0),
    normSanctionAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.normSanctionAmbiguousOrderingRecords, 0),
    normSanctionNoLaterStatusUpdateRecords: aggregate.reduce((sum, item) => sum + item.normSanctionNoLaterStatusUpdateRecords, 0)
  };
}

function summarizeGossipExposureTemporalAssociations(
  agents: SocialAgentSnapshot[],
  socialEpisode?: unknown
): GossipExposureTemporalAssociationEvaluation {
  const exposureRecords = exposureRecordsFromSocialEpisode(socialEpisode);
  const recordsByObserver = groupExposureRecordsByObserver(exposureRecords);
  const states = agents.flatMap((agent) => (agent.social ? [{ agent, social: agent.social }] : []));
  const aggregate = states.map(({ agent, social }) => {
    const observerExposureRecords = recordsByObserver.get(socialAgentId(agent)) ?? [];
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const gossipRecords = Object.values(social.gossip?.records ?? {});
    const evaluatedRecords = gossipRecords.map((record) =>
      evaluateGossipExposureRecord(record, journalEntries, observerExposureRecords, exposureRecords.length)
    );
    const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      hasExposureRecords: observerExposureRecords.length > 0,
      gossipRecords: gossipRecords.length,
      gossipEvaluableRecords: evaluableRecords.length,
      gossipAssociatedRecords: evaluableRecords.filter((record) => record.associated).length,
      gossipMissingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
      gossipMissingMessageEvidenceRecords: evaluatedRecords.filter((record) => record.missingMessageEvidence).length,
      gossipMissingScopedExposureRecords: evaluatedRecords.filter((record) => record.missingScopedExposure).length,
      gossipAmbiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
      gossipSameTurnIngestionRecords: evaluableRecords.filter((record) => record.sameTurnIngestion).length,
      gossipNoLaterCreationRecords: evaluableRecords.filter((record) => record.noLaterCreation).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    agentsWithExposureRecords: aggregate.filter((item) => item.hasExposureRecords).length,
    exposureRecords: exposureRecords.length,
    gossipRecords: aggregate.reduce((sum, item) => sum + item.gossipRecords, 0),
    gossipEvaluableRecords: aggregate.reduce((sum, item) => sum + item.gossipEvaluableRecords, 0),
    gossipAssociatedRecords: aggregate.reduce((sum, item) => sum + item.gossipAssociatedRecords, 0),
    gossipMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.gossipMissingCreationRecords, 0),
    gossipMissingMessageEvidenceRecords: aggregate.reduce((sum, item) => sum + item.gossipMissingMessageEvidenceRecords, 0),
    gossipMissingScopedExposureRecords: aggregate.reduce((sum, item) => sum + item.gossipMissingScopedExposureRecords, 0),
    gossipAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.gossipAmbiguousOrderingRecords, 0),
    gossipSameTurnIngestionRecords: aggregate.reduce((sum, item) => sum + item.gossipSameTurnIngestionRecords, 0),
    gossipNoLaterCreationRecords: aggregate.reduce((sum, item) => sum + item.gossipNoLaterCreationRecords, 0)
  };
}

function summarizeTrustRepairLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairLifecycleTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
    const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairLifecycleRecord(record, journalEntries));
    const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      trustRepairs: trustRepairs.length,
      trustRepairEvaluableRecords: evaluableRecords.length,
      trustRepairAssociatedRecords: evaluableRecords.filter((record) => record.associated).length,
      trustRepairMissingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
      trustRepairAmbiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
      trustRepairNoLaterStatusUpdateRecords: evaluableRecords.filter((record) => record.noLaterLifecycle).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    trustRepairs: aggregate.reduce((sum, item) => sum + item.trustRepairs, 0),
    trustRepairEvaluableRecords: aggregate.reduce((sum, item) => sum + item.trustRepairEvaluableRecords, 0),
    trustRepairAssociatedRecords: aggregate.reduce((sum, item) => sum + item.trustRepairAssociatedRecords, 0),
    trustRepairMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.trustRepairMissingCreationRecords, 0),
    trustRepairAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.trustRepairAmbiguousOrderingRecords, 0),
    trustRepairNoLaterStatusUpdateRecords: aggregate.reduce((sum, item) => sum + item.trustRepairNoLaterStatusUpdateRecords, 0)
  };
}

function summarizeTrustRepairRelationshipTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairRelationshipTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
    const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairRelationshipRecord(record, journalEntries));
    const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      trustRepairs: trustRepairs.length,
      relationshipEdges: Object.keys(social.relationships.edges).length,
      trustRepairRelationshipEvaluableRecords: evaluableRecords.length,
      trustRepairRelationshipAssociatedRecords: evaluableRecords.filter((record) => record.associated).length,
      trustRepairRelationshipMissingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
      trustRepairRelationshipAmbiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
      trustRepairRelationshipSameTurnMutationRecords: evaluableRecords.filter((record) => record.sameTurnMutation).length,
      trustRepairRelationshipNoLaterRelationshipUpdateRecords: evaluableRecords.filter((record) => record.noLaterMutation).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    trustRepairs: aggregate.reduce((sum, item) => sum + item.trustRepairs, 0),
    relationshipEdges: aggregate.reduce((sum, item) => sum + item.relationshipEdges, 0),
    trustRepairRelationshipEvaluableRecords: aggregate.reduce((sum, item) => sum + item.trustRepairRelationshipEvaluableRecords, 0),
    trustRepairRelationshipAssociatedRecords: aggregate.reduce((sum, item) => sum + item.trustRepairRelationshipAssociatedRecords, 0),
    trustRepairRelationshipMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.trustRepairRelationshipMissingCreationRecords, 0),
    trustRepairRelationshipAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.trustRepairRelationshipAmbiguousOrderingRecords, 0),
    trustRepairRelationshipSameTurnMutationRecords: aggregate.reduce((sum, item) => sum + item.trustRepairRelationshipSameTurnMutationRecords, 0),
    trustRepairRelationshipNoLaterRelationshipUpdateRecords: aggregate.reduce(
      (sum, item) => sum + item.trustRepairRelationshipNoLaterRelationshipUpdateRecords,
      0
    )
  };
}

function summarizeTrustRepairReputationTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairReputationTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const trustRepairs = Object.values(social.trustRepairs?.records ?? {});
    const evaluatedRecords = trustRepairs.map((record) => evaluateTrustRepairReputationRecord(record, journalEntries));
    const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      trustRepairs: trustRepairs.length,
      reputationRecords: Object.keys(social.reputation.records).length,
      trustRepairReputationEvaluableRecords: evaluableRecords.length,
      trustRepairReputationAssociatedRecords: evaluableRecords.filter((record) => record.associated).length,
      trustRepairReputationMissingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
      trustRepairReputationAmbiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
      trustRepairReputationSameTurnMutationRecords: evaluableRecords.filter((record) => record.sameTurnMutation).length,
      trustRepairReputationNoLaterReputationUpdateRecords: evaluableRecords.filter((record) => record.noLaterMutation).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    trustRepairs: aggregate.reduce((sum, item) => sum + item.trustRepairs, 0),
    reputationRecords: aggregate.reduce((sum, item) => sum + item.reputationRecords, 0),
    trustRepairReputationEvaluableRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationEvaluableRecords, 0),
    trustRepairReputationAssociatedRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationAssociatedRecords, 0),
    trustRepairReputationMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationMissingCreationRecords, 0),
    trustRepairReputationAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationAmbiguousOrderingRecords, 0),
    trustRepairReputationSameTurnMutationRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationSameTurnMutationRecords, 0),
    trustRepairReputationNoLaterReputationUpdateRecords: aggregate.reduce((sum, item) => sum + item.trustRepairReputationNoLaterReputationUpdateRecords, 0)
  };
}

function summarizeBetrayalLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): BetrayalLifecycleTemporalAssociationEvaluation {
  const states = agents.flatMap((agent) => (agent.social ? [{ social: agent.social }] : []));
  const aggregate = states.map(({ social }) => {
    const journalEntries = orderedJournalEntries(social.journal?.entries ?? []);
    const betrayals = Object.values(social.betrayals?.records ?? {});
    const evaluatedRecords = betrayals.map((record) => evaluateBetrayalLifecycleRecord(record, journalEntries));
    const evaluableRecords = evaluatedRecords.filter((record) => record.evaluable);
    return {
      hasJournal: journalEntries.length > 0,
      betrayals: betrayals.length,
      betrayalEvaluableRecords: evaluableRecords.length,
      betrayalAssociatedRecords: evaluableRecords.filter((record) => record.associated).length,
      betrayalMissingCreationRecords: evaluatedRecords.filter((record) => record.missingCreation).length,
      betrayalAmbiguousOrderingRecords: evaluatedRecords.filter((record) => record.ambiguousOrdering).length,
      betrayalNoLaterLifecycleEvidenceRecords: evaluableRecords.filter((record) => record.noLaterLifecycle).length
    };
  });
  return {
    agentCount: agents.length,
    agentsWithSocialState: states.length,
    agentsWithJournal: aggregate.filter((item) => item.hasJournal).length,
    betrayals: aggregate.reduce((sum, item) => sum + item.betrayals, 0),
    betrayalEvaluableRecords: aggregate.reduce((sum, item) => sum + item.betrayalEvaluableRecords, 0),
    betrayalAssociatedRecords: aggregate.reduce((sum, item) => sum + item.betrayalAssociatedRecords, 0),
    betrayalMissingCreationRecords: aggregate.reduce((sum, item) => sum + item.betrayalMissingCreationRecords, 0),
    betrayalAmbiguousOrderingRecords: aggregate.reduce((sum, item) => sum + item.betrayalAmbiguousOrderingRecords, 0),
    betrayalNoLaterLifecycleEvidenceRecords: aggregate.reduce((sum, item) => sum + item.betrayalNoLaterLifecycleEvidenceRecords, 0)
  };
}

function countMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: SOCIAL_STATE_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function ratioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: SOCIAL_STATE_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: "ratio",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function averageMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "score",
    higherIsBetter: false,
    weight: 0,
    source: SOCIAL_STATE_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: confidence(options.denominator),
    aggregation: "average",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function associationCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, associationMetadata(options.metadata))
  });
}

function associationRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: "ratio",
    evidenceRefs,
    metadata: withSocialHash(agent, associationMetadata(options.metadata))
  });
}

function associationMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    associationLevel: "explicit_evidence_or_metadata_association",
    causalClaim: false,
    ...metadata
  };
}

function lifecycleCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function lifecycleRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function normSanctionLifecycleCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function normSanctionLifecycleRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function gossipExposureTemporalCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function gossipExposureTemporalRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairLifecycleCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairLifecycleRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairRelationshipTemporalCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairRelationshipTemporalRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairReputationTemporalCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function trustRepairReputationTemporalRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function betrayalLifecycleCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function betrayalLifecycleRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    aggregation: "ratio" | "coverage_ratio";
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function lifecycleMetadata(temporalAssociationKind: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    associationLevel: "temporal_association",
    temporalAssociationKind,
    causalClaim: false,
    orderingRule: "strict_turnIndex_after_creation",
    hiddenTruthUsedInLiveStore: false,
    postgameTruthUsed: false,
    ...metadata
  };
}

function trustRepairJournalMutationMetadata(temporalAssociationKind: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return lifecycleMetadata(temporalAssociationKind, {
    repairSource: "AgentSocialState.trustRepairs.records",
    subjectMatchRule: "repair_actor_id",
    matchedParticipantRole: "actor",
    ...metadata
  });
}

function gossipExposureMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    associationLevel: "temporal_association",
    temporalAssociationKind: "gossip_exposure_journal_temporal_association",
    causalClaim: false,
    orderingRule: "strict_gossip_added_turnIndex_after_scoped_exposure",
    exposureSource: "SocialExposureRecord from deriveSocialExposureRecords",
    gossipSource: "AgentSocialState.gossip.records",
    mutationSource: "AgentSocialState.journal.entries:gossip.added",
    hiddenTruthUsedInLiveStore: false,
    postgameTruthUsed: false,
    ...metadata
  };
}

function dynamicsCountMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator?: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "count",
    higherIsBetter: false,
    weight: 0,
    source: SOCIAL_DYNAMICS_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: 1,
    aggregation: "sum",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function dynamicsRatioMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    denominator: number;
    confidence: number;
    metadata?: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: "ratio",
    higherIsBetter: true,
    weight: 0,
    source: SOCIAL_DYNAMICS_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: "ratio",
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

function socialSubject(agent: SocialAgentSnapshot): Record<string, unknown> {
  const actorId = socialAgentId(agent);
  const profileId = agent.profileId ?? agent.social?.profile.id;
  const model = agent.model ?? agent.social?.profile.model;
  const policyId = agent.policyId ?? agent.social?.profile.policyId ?? legacySocialProjection(agent).policyName;
  return {
    actorId,
    profileId,
    model,
    policyId,
    // Kept for existing Werewolf artifact readers while new domains consume
    // the domain-neutral actorId/policyId fields above.
    playerId: actorId,
    policyName: policyId
  };
}

function socialAgentId(agent: SocialAgentSnapshot): string {
  const actorId = agent.id ?? agent.social?.agentId ?? legacySocialProjection(agent).playerId;
  if (!actorId) {
    throw new Error("Social evaluator requires snapshot.id, snapshot.social.agentId, or a legacy playerId.");
  }
  return actorId;
}

function legacySocialProjection(agent: SocialAgentSnapshot): LegacySocialAgentProjection {
  return agent as SocialAgentSnapshot & LegacySocialAgentProjection;
}

function agentStateEvidence(agent: SocialAgentSnapshot): HarnessMetricEvidenceRef[] {
  return [
    {
      artifact: "agent_state",
      id: socialAgentId(agent),
      description: `socialStateHash:${agent.socialStateHash ?? "unknown"}`
    }
  ];
}

function isCoordinationMessage(agent: SocialAgentSnapshot, entry: SocialMemoryEntry): boolean {
  if (entry.visibility === "team") return true;
  if (entry.visibility === "private" && entry.source !== socialAgentId(agent) && entry.source !== "environment" && entry.source !== "reasoner") return true;
  return false;
}

function isNormPressureRecord(norm: NormRecord): boolean {
  return Boolean(norm.sanction) || norm.kind === "obligation" || norm.kind === "prohibition" || norm.status === "violated" || norm.status === "fulfilled";
}

function coalitionSignalRecords(
  relationships: RelationshipEdge[],
  reputations: ReputationRecord[]
): Array<{ kind: "relationship" | "reputation"; subjectId: string; evidenceRefs: EvidenceRef[] }> {
  return [
    ...relationships
      .filter((edge) => edge.trust > 0.1 || edge.affinity > 0.1)
      .map((edge) => ({ kind: "relationship" as const, subjectId: edge.targetId, evidenceRefs: edge.evidenceRefs })),
    ...reputations
      .filter((record) => record.cooperation > 0)
      .map((record) => ({ kind: "reputation" as const, subjectId: record.subjectId, evidenceRefs: record.evidenceRefs }))
  ];
}

function evidenceFromRelationships(agent: SocialAgentSnapshot, records: RelationshipEdge[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromReputation(agent: SocialAgentSnapshot, records: ReputationRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromNorms(agent: SocialAgentSnapshot, records: NormRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromMemories(agent: SocialAgentSnapshot, records: SocialMemoryEntry[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromCommitments(agent: SocialAgentSnapshot, records: CommitmentRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromCoalitions(agent: SocialAgentSnapshot, records: CoalitionRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromGossip(agent: SocialAgentSnapshot, records: GossipRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromNormSanctions(agent: SocialAgentSnapshot, records: NormSanctionRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromTrustRepairs(agent: SocialAgentSnapshot, records: TrustRepairRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromBetrayals(agent: SocialAgentSnapshot, records: BetrayalRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

function evidenceFromGossipExposureRecords(agent: SocialAgentSnapshot, records: GossipExposureRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [...record.messageEvidenceRefs, ...(record.creationEntry?.evidenceRefs ?? [])]);
  const exposureEvidenceRefs = records.flatMap((record) => evidenceFromExposureRecords(agent, record.associatedExposureRecords));
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...exposureEvidenceRefs, ...agentStateEvidence(agent)]);
}

function evidenceFromCoalitionSignals(
  agent: SocialAgentSnapshot,
  records: Array<{ evidenceRefs: EvidenceRef[] }>
): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

interface CommitmentCoalitionPair {
  commitment: CommitmentRecord;
  coalition: CoalitionRecord;
  evaluable: boolean;
  associationKinds: string[];
  evidenceRefs: EvidenceRef[];
}

function commitmentCoalitionPairs(commitments: CommitmentRecord[], coalitions: CoalitionRecord[]): CommitmentCoalitionPair[] {
  const pairs: CommitmentCoalitionPair[] = [];
  for (const commitment of commitments) {
    for (const coalition of coalitions) {
      const associationKinds = commitmentCoalitionAssociationKinds(commitment, coalition);
      pairs.push({
        commitment,
        coalition,
        evaluable: commitment.evidenceRefs.length > 0 && coalition.evidenceRefs.length > 0,
        associationKinds,
        evidenceRefs: uniqueSocialEvidenceRefs([...commitment.evidenceRefs, ...coalition.evidenceRefs])
      });
    }
  }
  return pairs;
}

function commitmentCoalitionAssociationKinds(commitment: CommitmentRecord, coalition: CoalitionRecord): string[] {
  const kinds: string[] = [];
  if (hasSharedEvidence(commitment.evidenceRefs, coalition.evidenceRefs)) kinds.push("shared-evidence");
  if (hasExplicitCommitmentCoalitionMetadataLink(commitment, coalition)) kinds.push("metadata-link");
  return kinds;
}

function hasSharedEvidence(left: EvidenceRef[], right: EvidenceRef[]): boolean {
  const leftKeys = new Set(left.flatMap((ref) => evidenceKeys(ref)));
  return right.some((ref) => evidenceKeys(ref).some((key) => leftKeys.has(key)));
}

function hasExplicitCommitmentCoalitionMetadataLink(commitment: CommitmentRecord, coalition: CoalitionRecord): boolean {
  return (
    metadataReferencesId(commitment.metadata, "coalitionId", coalition.id) ||
    metadataReferencesId(commitment.metadata, "coalitionIds", coalition.id) ||
    metadataReferencesId(coalition.metadata, "commitmentId", commitment.id) ||
    metadataReferencesId(coalition.metadata, "commitmentIds", commitment.id)
  );
}

function metadataReferencesId(metadata: Record<string, unknown> | undefined, key: string, id: string): boolean {
  const value = metadata?.[key];
  if (typeof value === "string") return value === id;
  if (Array.isArray(value)) return value.some((item) => item === id);
  return false;
}

function evidenceKeys(ref: EvidenceRef): string[] {
  const keys: string[] = [];
  if (ref.id) keys.push(`${ref.artifact}:id:${ref.id}`);
  if (ref.traceId) keys.push(`${ref.artifact}:trace:${ref.traceId}`);
  if (ref.seq !== undefined) keys.push(`${ref.artifact}:seq:${ref.seq}`);
  return keys;
}

function evidenceFromCommitmentCoalitionPairs(agent: SocialAgentSnapshot, pairs: CommitmentCoalitionPair[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, pairs.flatMap((pair) => pair.evidenceRefs));
}

function uniqueSocialEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function sampleAssociationPairs(pairs: CommitmentCoalitionPair[]): Array<{
  commitmentId: string;
  coalitionId: string;
  associationKinds: string[];
}> {
  return pairs.slice(0, 20).map((pair) => ({
    commitmentId: pair.commitment.id,
    coalitionId: pair.coalition.id,
    associationKinds: pair.associationKinds
  }));
}

interface LifecycleRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  ambiguousOrdering: boolean;
  noLaterLifecycle: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  lifecycleEntries: SocialStateMutationJournalEntry[];
  associatedLifecycleEntries: SocialStateMutationJournalEntry[];
  lifecycleKinds: string[];
}

interface GossipExposureRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  missingMessageEvidence: boolean;
  missingScopedExposure: boolean;
  ambiguousOrdering: boolean;
  sameTurnIngestion: boolean;
  noLaterCreation: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  messageEvidenceRefs: EvidenceRef[];
  matchingExposureRecords: SocialExposureRecord[];
  associatedExposureRecords: SocialExposureRecord[];
}

interface TrustRepairJournalMutationRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  ambiguousOrdering: boolean;
  sameTurnMutation: boolean;
  noLaterMutation: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  mutationEntries: SocialStateMutationJournalEntry[];
  associatedMutationEntries: SocialStateMutationJournalEntry[];
  mutationDimensions: string[];
}

function orderedJournalEntries(entries: SocialStateMutationJournalEntry[]): SocialStateMutationJournalEntry[] {
  return [...entries].sort((left, right) => left.journalSeq - right.journalSeq);
}

function evaluateCommitmentLifecycleRecord(
  record: CommitmentRecord,
  entries: SocialStateMutationJournalEntry[]
): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "commitments" &&
      entry.mutationKind === "commitment.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "commitments" &&
      entry.mutationKind === "commitment.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

function evaluateCoalitionLifecycleRecord(record: CoalitionRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "coalitions" &&
      entry.mutationKind === "coalition.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "coalitions" &&
      entry.mutationKind === "coalition.evidence.recorded" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false &&
      isCoalitionLifecycleEvidenceKind(entry.deltaSummary?.evidenceKind)
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.evidenceKind))
  });
}

function evaluateNormLifecycleRecord(record: NormRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "norms" &&
      entry.mutationKind === "norm.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "norms" &&
      entry.mutationKind === "norm.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

function evaluateNormSanctionLifecycleRecord(record: NormSanctionRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "normSanctions" &&
      entry.mutationKind === "norm_sanction.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "normSanctions" &&
      entry.mutationKind === "norm_sanction.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

function evaluateTrustRepairLifecycleRecord(record: TrustRepairRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

function evaluateBetrayalLifecycleRecord(record: BetrayalRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "betrayals" &&
      entry.mutationKind === "betrayal.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "betrayals" &&
      entry.mutationKind === "betrayal.evidence.recorded" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.evidenceKind))
  });
}

const RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS = ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"];
const REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS = ["honesty", "competence", "cooperation", "threat", "normCompliance"];

function evaluateTrustRepairRelationshipRecord(
  record: TrustRepairRecord,
  entries: SocialStateMutationJournalEntry[]
): TrustRepairJournalMutationRecordEvaluation {
  return evaluateTrustRepairJournalMutationRecord({
    record,
    entries,
    store: "relationships",
    mutationKind: "relationship.updated",
    dimensions: RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS
  });
}

function evaluateTrustRepairReputationRecord(
  record: TrustRepairRecord,
  entries: SocialStateMutationJournalEntry[]
): TrustRepairJournalMutationRecordEvaluation {
  return evaluateTrustRepairJournalMutationRecord({
    record,
    entries,
    store: "reputation",
    mutationKind: "reputation.updated",
    dimensions: REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS
  });
}

function evaluateTrustRepairJournalMutationRecord(input: {
  record: TrustRepairRecord;
  entries: SocialStateMutationJournalEntry[];
  store: "relationships" | "reputation";
  mutationKind: "relationship.updated" | "reputation.updated";
  dimensions: string[];
}): TrustRepairJournalMutationRecordEvaluation {
  const creationEntry = input.entries.find(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.added" &&
      entry.subjectId === input.record.id &&
      entry.hiddenTruthUsed === false
  );
  const mutationEntries = input.entries.filter(
    (entry) =>
      entry.store === input.store &&
      entry.mutationKind === input.mutationKind &&
      entry.subjectId === input.record.actorId &&
      entry.hiddenTruthUsed === false &&
      journalEntryHasDimensionDelta(entry, input.dimensions)
  );
  const mutationDimensions = mutationEntries.flatMap((entry) => journalEntryDimensions(entry, input.dimensions));

  if (!creationEntry) {
    return trustRepairJournalMutationRecordResult(input.record.id, {
      missingCreation: true,
      mutationEntries,
      mutationDimensions
    });
  }

  const relevantEntries = [creationEntry, ...mutationEntries];
  if (relevantEntries.some((entry) => typeof entry.turnIndex !== "number")) {
    return trustRepairJournalMutationRecordResult(input.record.id, {
      creationEntry,
      mutationEntries,
      mutationDimensions,
      ambiguousOrdering: true
    });
  }

  const creationTurnIndex = creationEntry.turnIndex as number;
  const associatedMutationEntries = mutationEntries.filter((entry) => (entry.turnIndex as number) > creationTurnIndex);
  const sameTurnMutation = associatedMutationEntries.length === 0 && mutationEntries.some((entry) => entry.turnIndex === creationTurnIndex);
  return trustRepairJournalMutationRecordResult(input.record.id, {
    evaluable: true,
    associated: associatedMutationEntries.length > 0,
    creationEntry,
    mutationEntries,
    associatedMutationEntries,
    mutationDimensions,
    sameTurnMutation,
    noLaterMutation: associatedMutationEntries.length === 0 && !sameTurnMutation
  });
}

function evaluateGossipExposureRecord(
  record: GossipRecord,
  entries: SocialStateMutationJournalEntry[],
  exposureRecords: SocialExposureRecord[],
  totalExposureRecords: number
): GossipExposureRecordEvaluation {
  const creationEntry = entries.find(
    (entry) => entry.store === "gossip" && entry.mutationKind === "gossip.added" && entry.subjectId === record.id && entry.hiddenTruthUsed === false
  );
  const messageEvidenceRefs = messageEvidenceFromGossip(record, creationEntry);
  const matchingExposureRecords = orderedExposureRecords(exposureRecords.filter((exposure) => messageEvidenceRefs.some((ref) => exposureMatchesMessageRef(exposure, ref))));

  if (!creationEntry) {
    return gossipExposureRecordResult(record.id, {
      missingCreation: true,
      messageEvidenceRefs,
      matchingExposureRecords
    });
  }
  if (!messageEvidenceRefs.length) {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      missingMessageEvidence: true
    });
  }
  if (!matchingExposureRecords.length) {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      messageEvidenceRefs,
      missingScopedExposure: true,
      missingScopedExposureSource: totalExposureRecords === 0
    });
  }
  if (typeof creationEntry.turnIndex !== "number") {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      messageEvidenceRefs,
      matchingExposureRecords,
      ambiguousOrdering: true
    });
  }

  const creationTurnIndex = creationEntry.turnIndex;
  const associatedExposureRecords = matchingExposureRecords.filter((exposure) => exposure.observedAtTurnIndex < creationTurnIndex);
  const associated = associatedExposureRecords.length > 0;
  const sameTurnIngestion = !associated && matchingExposureRecords.some((exposure) => exposure.observedAtTurnIndex === creationTurnIndex);
  return gossipExposureRecordResult(record.id, {
    evaluable: true,
    associated,
    creationEntry,
    messageEvidenceRefs,
    matchingExposureRecords,
    associatedExposureRecords,
    sameTurnIngestion,
    noLaterCreation: !associated
  });
}

function evaluateLifecycleRecord(input: {
  recordId: string;
  creationEntry?: SocialStateMutationJournalEntry;
  lifecycleEntries: SocialStateMutationJournalEntry[];
  lifecycleKinds: string[];
}): LifecycleRecordEvaluation {
  if (!input.creationEntry) {
    return {
      recordId: input.recordId,
      evaluable: false,
      associated: false,
      missingCreation: true,
      ambiguousOrdering: false,
      noLaterLifecycle: false,
      lifecycleEntries: input.lifecycleEntries,
      associatedLifecycleEntries: [],
      lifecycleKinds: input.lifecycleKinds
    };
  }
  const relevantEntries = [input.creationEntry, ...input.lifecycleEntries];
  const ambiguousOrdering = relevantEntries.some((entry) => typeof entry.turnIndex !== "number");
  if (ambiguousOrdering) {
    return {
      recordId: input.recordId,
      evaluable: false,
      associated: false,
      missingCreation: false,
      ambiguousOrdering: true,
      noLaterLifecycle: false,
      creationEntry: input.creationEntry,
      lifecycleEntries: input.lifecycleEntries,
      associatedLifecycleEntries: [],
      lifecycleKinds: input.lifecycleKinds
    };
  }
  const creationTurnIndex = input.creationEntry.turnIndex as number;
  const associatedLifecycleEntries = input.lifecycleEntries.filter((entry) => (entry.turnIndex as number) > creationTurnIndex);
  return {
    recordId: input.recordId,
    evaluable: true,
    associated: associatedLifecycleEntries.length > 0,
    missingCreation: false,
    ambiguousOrdering: false,
    noLaterLifecycle: associatedLifecycleEntries.length === 0,
    creationEntry: input.creationEntry,
    lifecycleEntries: input.lifecycleEntries,
    associatedLifecycleEntries,
    lifecycleKinds: input.lifecycleKinds
  };
}

function isCoalitionLifecycleEvidenceKind(value: unknown): boolean {
  return value === "coordination" || value === "betrayal" || value === "dissolution";
}

function stringValue(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function gossipExposureRecordResult(
  recordId: string,
  options: Partial<Omit<GossipExposureRecordEvaluation, "recordId">> & { missingScopedExposureSource?: boolean }
): GossipExposureRecordEvaluation {
  void options.missingScopedExposureSource;
  return {
    recordId,
    evaluable: options.evaluable ?? false,
    associated: options.associated ?? false,
    missingCreation: options.missingCreation ?? false,
    missingMessageEvidence: options.missingMessageEvidence ?? false,
    missingScopedExposure: options.missingScopedExposure ?? false,
    ambiguousOrdering: options.ambiguousOrdering ?? false,
    sameTurnIngestion: options.sameTurnIngestion ?? false,
    noLaterCreation: options.noLaterCreation ?? false,
    creationEntry: options.creationEntry,
    messageEvidenceRefs: options.messageEvidenceRefs ?? [],
    matchingExposureRecords: options.matchingExposureRecords ?? [],
    associatedExposureRecords: options.associatedExposureRecords ?? []
  };
}

function trustRepairJournalMutationRecordResult(
  recordId: string,
  options: Partial<Omit<TrustRepairJournalMutationRecordEvaluation, "recordId">>
): TrustRepairJournalMutationRecordEvaluation {
  return {
    recordId,
    evaluable: options.evaluable ?? false,
    associated: options.associated ?? false,
    missingCreation: options.missingCreation ?? false,
    ambiguousOrdering: options.ambiguousOrdering ?? false,
    sameTurnMutation: options.sameTurnMutation ?? false,
    noLaterMutation: options.noLaterMutation ?? false,
    creationEntry: options.creationEntry,
    mutationEntries: options.mutationEntries ?? [],
    associatedMutationEntries: options.associatedMutationEntries ?? [],
    mutationDimensions: sampleIds(options.mutationDimensions ?? [])
  };
}

function journalEntryHasDimensionDelta(entry: SocialStateMutationJournalEntry, dimensions: string[]): boolean {
  return journalEntryDimensions(entry, dimensions).length > 0;
}

function journalEntryDimensions(entry: SocialStateMutationJournalEntry, dimensions: string[]): string[] {
  return dimensions.filter((dimension) => typeof entry.deltaSummary?.[dimension] === "number" && entry.deltaSummary[dimension] !== 0);
}

function messageEvidenceFromGossip(record: GossipRecord, creationEntry?: SocialStateMutationJournalEntry): EvidenceRef[] {
  return uniqueSocialEvidenceRefs([...record.evidenceRefs, ...(creationEntry?.evidenceRefs ?? [])].filter(isMessageEvidenceRef));
}

function isMessageEvidenceRef(ref: EvidenceRef): boolean {
  return ref.artifact === "message" && (typeof ref.id === "string" || typeof ref.seq === "number");
}

function exposureMatchesMessageRef(exposure: SocialExposureRecord, ref: EvidenceRef): boolean {
  if (typeof ref.id === "string" && exposure.messageId === ref.id) return true;
  return typeof ref.seq === "number" && exposure.messageSeq === ref.seq;
}

function orderedExposureRecords(records: SocialExposureRecord[]): SocialExposureRecord[] {
  return [...records].sort((left, right) => {
    if (left.observedAtTurnIndex !== right.observedAtTurnIndex) return left.observedAtTurnIndex - right.observedAtTurnIndex;
    if (left.messageSeq !== right.messageSeq) return left.messageSeq - right.messageSeq;
    return left.observedAtTraceId.localeCompare(right.observedAtTraceId);
  });
}

function evidenceFromLifecycleRecords(agent: SocialAgentSnapshot, records: LifecycleRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [
    ...(record.creationEntry?.evidenceRefs ?? []),
    ...record.lifecycleEntries.flatMap((entry) => entry.evidenceRefs)
  ]);
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...agentStateEvidence(agent)]);
}

function evidenceFromJournalMutationRecords(agent: SocialAgentSnapshot, records: TrustRepairJournalMutationRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [
    ...(record.creationEntry?.evidenceRefs ?? []),
    ...record.mutationEntries.flatMap((entry) => entry.evidenceRefs)
  ]);
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...agentStateEvidence(agent)]);
}

function sampleLifecycleRecords(records: LifecycleRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  lifecycleTurnIndexes: number[];
  lifecycleKinds: string[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    lifecycleTurnIndexes: record.associatedLifecycleEntries.flatMap((entry) => (typeof entry.turnIndex === "number" ? [entry.turnIndex] : [])),
    lifecycleKinds: sampleIds(record.lifecycleKinds)
  }));
}

function sampleJournalMutationRecords(records: TrustRepairJournalMutationRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  mutationTurnIndexes: number[];
  mutationKinds: string[];
  mutationDimensions: string[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    mutationTurnIndexes: record.associatedMutationEntries.flatMap((entry) => (typeof entry.turnIndex === "number" ? [entry.turnIndex] : [])),
    mutationKinds: sampleIds(record.associatedMutationEntries.map((entry) => entry.mutationKind)),
    mutationDimensions: sampleIds(record.associatedMutationEntries.flatMap((entry) => journalEntryDimensions(entry, record.mutationDimensions)))
  }));
}

function mutationDimensions(records: TrustRepairJournalMutationRecordEvaluation[]): string[] {
  return sampleIds([...new Set(records.flatMap((record) => record.mutationDimensions))].sort());
}

function sampleGossipExposureRecords(records: GossipExposureRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  exposureTurnIndexes: number[];
  messageIds: string[];
  messageSeqs: number[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    exposureTurnIndexes: record.associatedExposureRecords.map((exposure) => exposure.observedAtTurnIndex),
    messageIds: sampleIds(record.associatedExposureRecords.map((exposure) => exposure.messageId)),
    messageSeqs: record.associatedExposureRecords.map((exposure) => exposure.messageSeq).slice(0, 20)
  }));
}

function evidenceFromExposureRecords(agent: SocialAgentSnapshot, records: SocialExposureRecord[]): HarnessMetricEvidenceRef[] {
  const refs: HarnessMetricEvidenceRef[] = [];
  for (const record of records) {
    for (const ref of record.evidenceRefs) {
      if (ref.artifact === "message") {
        refs.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "delivery_receipt") {
        refs.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "trace") {
        refs.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "observation") {
        refs.push({
          artifact: "observation",
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId,
          description: ref.description ?? `scoped exposure of ${record.messageId}`
        });
        continue;
      }
      refs.push({
        artifact: "observation",
        id: ref.id,
        seq: ref.seq,
        traceId: ref.traceId,
        description: ref.description ?? `scoped exposure of ${record.messageId}`
      });
    }
  }
  const unique = uniqueEvidenceRefs(refs);
  return unique.length ? unique : agentStateEvidence(agent);
}

function evidenceFromSocialRefs(agent: SocialAgentSnapshot, refs: EvidenceRef[]): HarnessMetricEvidenceRef[] {
  const mapped: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    if (ref.artifact === "message") {
      mapped.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "delivery_receipt") {
      mapped.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "event") {
      mapped.push({ artifact: "event", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "trace") {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "observation") {
      mapped.push({ artifact: "observation", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "state" || ref.artifact === "outcome") {
      mapped.push({ artifact: "state", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.traceId) {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: `${ref.artifact}:${ref.description ?? ""}` });
      continue;
    }
    mapped.push({ artifact: "agent_state", id: socialAgentId(agent), seq: ref.seq, description: `${ref.artifact}:${ref.description ?? "social evidence"}` });
  }
  const unique = uniqueEvidenceRefs(mapped);
  return unique.length ? unique : agentStateEvidence(agent);
}

function uniqueEvidenceRefs(refs: HarnessMetricEvidenceRef[]): HarnessMetricEvidenceRef[] {
  const seen = new Set<string>();
  const unique: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function withSocialHash(agent: SocialAgentSnapshot, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...metadata,
    socialStateHash: agent.socialStateHash ?? null
  };
}

type SocialEpisodeExposureInput = Pick<SocialEpisodeArtifact<unknown, unknown, unknown, unknown>, "steps" | "messages">;

function exposureRecordsFromSocialEpisode(socialEpisode?: unknown): SocialExposureRecord[] {
  const materialized = materializedExposureRecordsFromSocialEpisode(socialEpisode);
  if (materialized) return materialized;
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  return exposureInput ? deriveSocialExposureRecords(exposureInput) : [];
}

function materializedExposureRecordsFromSocialEpisode(socialEpisode?: unknown): SocialExposureRecord[] | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as { exposureRecords?: unknown };
  if (!Array.isArray(candidate.exposureRecords)) return undefined;
  return candidate.exposureRecords.filter(isSocialExposureRecord);
}

function socialEpisodeExposureInput(socialEpisode?: unknown): SocialEpisodeExposureInput | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as Partial<SocialEpisodeExposureInput>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.messages)) return undefined;
  return {
    steps: candidate.steps,
    messages: candidate.messages
  };
}

function messagesFromSocialEpisode(socialEpisode?: unknown): SocialMessage[] {
  if (!socialEpisode || typeof socialEpisode !== "object") return [];
  const candidate = socialEpisode as { messages?: unknown };
  return Array.isArray(candidate.messages) ? candidate.messages.filter(isSocialMessageForEvaluation) : [];
}

function socialMessageIndex(messages: SocialMessage[]): SocialMessageIndex {
  return {
    byId: new Map(messages.map((message) => [message.id, message])),
    bySeq: new Map(messages.map((message) => [message.seq, message]))
  };
}

function groupExposureRecordsByObserver(records: SocialExposureRecord[]): Map<string, SocialExposureRecord[]> {
  const grouped = new Map<string, SocialExposureRecord[]>();
  for (const record of records) {
    grouped.set(record.observerId, [...(grouped.get(record.observerId) ?? []), record]);
  }
  return grouped;
}

function visibilityCounts(records: SocialExposureRecord[]): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.visibility] = (counts[record.visibility] ?? 0) + 1;
    return counts;
  }, {});
}

function sampleIds(ids: string[]): string[] {
  return ids.slice(0, 20);
}

function countStrings(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function socialFactsFromMessage(message: SocialMessage): Array<Record<string, unknown>> {
  const facts = message.metadata?.socialFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object" && !Array.isArray(fact));
}

function isMetadataDerivedSocialSpeechAct(act: SocialSpeechAct): boolean {
  return stringMetadataValue(act.metadata?.source)?.startsWith("metadata.") === true;
}

function speechActIdForEvaluation(act: SocialSpeechAct, speechActIndex: number): string {
  return act.id.trim() || `index-${speechActIndex}`;
}

function stringMetadataValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayMetadataValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function hasNumericDelta(value: unknown, dimensions: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return dimensions.some((dimension) => typeof record[dimension] === "number" && Number.isFinite(record[dimension]));
}

function isSocialMessageForEvaluation(value: unknown): value is SocialMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.seq === "number" &&
    Number.isFinite(record.seq) &&
    typeof record.channelId === "string" &&
    typeof record.senderId === "string" &&
    Array.isArray(record.recipientIds) &&
    typeof record.visibility === "string" &&
    typeof record.content === "string"
  );
}

function isSocialSpeechActForEvaluation(value: unknown): value is SocialSpeechAct {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.kind === "string";
}

function isSocialExposureRecord(value: unknown): value is SocialExposureRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.messageId === "string" &&
    typeof record.messageSeq === "number" &&
    typeof record.sourceId === "string" &&
    typeof record.observerId === "string" &&
    typeof record.observedAtTraceId === "string" &&
    typeof record.observedAtTurnIndex === "number" &&
    typeof record.channelId === "string" &&
    typeof record.visibility === "string" &&
    Array.isArray(record.evidenceRefs)
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? round3(numerator / denominator) : 0;
}

function average(values: number[]): number {
  return values.length ? round3(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function confidence(denominator: number): number {
  return denominator > 0 ? 1 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
