import { type HarnessEvaluatorManifestConfig } from "../types";
import { type HarnessEvaluationContext, type HarnessEvaluator } from "../evaluation";
import { type AgentSocialState } from "../socialState";
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

export interface LegacySocialAgentProjection {
  playerId?: string;
  policyName?: string;
}

export type SocialEvaluationContext<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown> = HarnessEvaluationContext<
  TState,
  TMetrics,
  TSocialEpisode,
  SocialAgentSnapshot,
  unknown
>;

export type SocialEvaluator<TState = unknown, TMetrics = unknown, TSocialEpisode = unknown, TOutput = unknown> = HarnessEvaluator<
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
  commitmentSpeechActOutsideRetainedJournalWindowCandidates: number;
  coalitionSpeechActCandidates: number;
  coalitionSpeechActLinkedCandidates: number;
  coalitionSpeechActMissingMutationCandidates: number;
  coalitionSpeechActOutsideRetainedJournalWindowCandidates: number;
  relationshipFactCandidates: number;
  relationshipFactLinkedCandidates: number;
  relationshipFactMissingMutationCandidates: number;
  relationshipFactOutsideRetainedJournalWindowCandidates: number;
  reputationFactCandidates: number;
  reputationFactLinkedCandidates: number;
  reputationFactMissingMutationCandidates: number;
  reputationFactOutsideRetainedJournalWindowCandidates: number;
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
