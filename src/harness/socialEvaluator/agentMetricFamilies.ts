import { type SocialExposureRecord } from "../social";
import { commitmentCoalitionPairs, evaluateBetrayalLifecycleRecord, evaluateCoalitionLifecycleRecord, evaluateCommitmentLifecycleRecord, evaluateGossipExposureRecord, evaluateNormLifecycleRecord, evaluateNormSanctionLifecycleRecord, evaluateTrustRepairLifecycleRecord, evaluateTrustRepairRelationshipRecord, evaluateTrustRepairReputationRecord, evidenceFromCommitmentCoalitionPairs, evidenceFromJournalMutationRecords, evidenceFromLifecycleRecords, mutationDimensions, orderedJournalEntries, RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS, REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS, sampleAssociationPairs, sampleGossipExposureRecords, sampleJournalMutationRecords, sampleLifecycleRecords } from "./lifecycleEvaluation";
import { confidence, ratio, sampleIds, visibilityCounts } from "./episodeData";
import { associationCountMetric, associationRatioMetric, betrayalLifecycleCountMetric, betrayalLifecycleRatioMetric, dynamicsCountMetric, dynamicsRatioMetric, gossipExposureMetadata, gossipExposureTemporalCountMetric, gossipExposureTemporalRatioMetric, lifecycleCountMetric, lifecycleMetadata, lifecycleRatioMetric, normSanctionLifecycleCountMetric, normSanctionLifecycleRatioMetric, trustRepairJournalMutationMetadata, trustRepairLifecycleCountMetric, trustRepairLifecycleRatioMetric, trustRepairRelationshipTemporalCountMetric, trustRepairRelationshipTemporalRatioMetric, trustRepairReputationTemporalCountMetric, trustRepairReputationTemporalRatioMetric } from "./metricBuilders";
import { coalitionSignalRecords, evidenceFromCoalitionSignals, evidenceFromExposureRecords, evidenceFromGossipExposureRecords, evidenceFromMemories, evidenceFromNorms, evidenceFromRelationships, evidenceFromReputation, isCoordinationMessage, isNormPressureRecord, socialSubject } from "./evidence";
import { type HarnessMetricRecord } from "../types";
import { type SocialAgentSnapshot } from "./manifests";
export function dynamicsMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function commitmentCoalitionAssociationMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function commitmentCoalitionLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function normSanctionLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function gossipExposureTemporalMetricsForAgent(
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

export function trustRepairLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function trustRepairRelationshipTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function trustRepairReputationTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function betrayalLifecycleTemporalMetricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

export function exposureMetricsForAgent(
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

