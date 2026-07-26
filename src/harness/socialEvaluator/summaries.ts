import { commitmentCoalitionPairs, evaluateBetrayalLifecycleRecord, evaluateCoalitionLifecycleRecord, evaluateCommitmentLifecycleRecord, evaluateGossipExposureRecord, evaluateNormLifecycleRecord, evaluateNormSanctionLifecycleRecord, evaluateTrustRepairLifecycleRecord, evaluateTrustRepairRelationshipRecord, evaluateTrustRepairReputationRecord, orderedJournalEntries } from "./lifecycleEvaluation";
import { evaluateSocialFactIngestEvidenceForAgent, type SocialFactIngestCandidateKind } from "./factIngest";
import { coalitionSignalRecords, isCoordinationMessage, isNormPressureRecord, socialAgentId } from "./evidence";
import { exposureRecordsFromSocialEpisode, groupExposureRecordsByObserver, messagesFromSocialEpisode, socialMessageIndex } from "./episodeData";
import { type BetrayalLifecycleTemporalAssociationEvaluation, type CommitmentCoalitionAssociationEvaluation, type CommitmentCoalitionLifecycleTemporalAssociationEvaluation, type GossipExposureTemporalAssociationEvaluation, type NormSanctionLifecycleTemporalAssociationEvaluation, type SocialAgentSnapshot, type SocialDynamicsEvaluation, type SocialFactIngestEvidenceEvaluation, type SocialStateEvaluation, type TrustRepairLifecycleTemporalAssociationEvaluation, type TrustRepairRelationshipTemporalAssociationEvaluation, type TrustRepairReputationTemporalAssociationEvaluation } from "./manifests";
export function summarizeSocialState(agents: SocialAgentSnapshot[]): SocialStateEvaluation {
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

export function summarizeSocialDynamics(agents: SocialAgentSnapshot[], socialEpisode?: unknown): SocialDynamicsEvaluation {
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

export function summarizeSocialFactIngestEvidence(agents: SocialAgentSnapshot[], socialEpisode?: unknown): SocialFactIngestEvidenceEvaluation {
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
      commitmentSpeechActOutsideRetainedJournalWindowCandidates: commitment.filter((item) => item.outsideRetainedJournalWindow).length,
      coalitionSpeechActCandidates: coalition.length,
      coalitionSpeechActLinkedCandidates: coalition.filter((item) => item.linked).length,
      coalitionSpeechActMissingMutationCandidates: coalition.filter((item) => item.missingMutation).length,
      coalitionSpeechActOutsideRetainedJournalWindowCandidates: coalition.filter((item) => item.outsideRetainedJournalWindow).length,
      relationshipFactCandidates: relationship.length,
      relationshipFactLinkedCandidates: relationship.filter((item) => item.linked).length,
      relationshipFactMissingMutationCandidates: relationship.filter((item) => item.missingMutation).length,
      relationshipFactOutsideRetainedJournalWindowCandidates: relationship.filter((item) => item.outsideRetainedJournalWindow).length,
      reputationFactCandidates: reputation.length,
      reputationFactLinkedCandidates: reputation.filter((item) => item.linked).length,
      reputationFactMissingMutationCandidates: reputation.filter((item) => item.missingMutation).length,
      reputationFactOutsideRetainedJournalWindowCandidates: reputation.filter((item) => item.outsideRetainedJournalWindow).length
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
    commitmentSpeechActOutsideRetainedJournalWindowCandidates: aggregate.reduce((sum, item) => sum + item.commitmentSpeechActOutsideRetainedJournalWindowCandidates, 0),
    coalitionSpeechActCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActCandidates, 0),
    coalitionSpeechActLinkedCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActLinkedCandidates, 0),
    coalitionSpeechActMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActMissingMutationCandidates, 0),
    coalitionSpeechActOutsideRetainedJournalWindowCandidates: aggregate.reduce((sum, item) => sum + item.coalitionSpeechActOutsideRetainedJournalWindowCandidates, 0),
    relationshipFactCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactCandidates, 0),
    relationshipFactLinkedCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactLinkedCandidates, 0),
    relationshipFactMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactMissingMutationCandidates, 0),
    relationshipFactOutsideRetainedJournalWindowCandidates: aggregate.reduce((sum, item) => sum + item.relationshipFactOutsideRetainedJournalWindowCandidates, 0),
    reputationFactCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactCandidates, 0),
    reputationFactLinkedCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactLinkedCandidates, 0),
    reputationFactMissingMutationCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactMissingMutationCandidates, 0),
    reputationFactOutsideRetainedJournalWindowCandidates: aggregate.reduce((sum, item) => sum + item.reputationFactOutsideRetainedJournalWindowCandidates, 0)
  };
}

export function summarizeCommitmentCoalitionAssociations(agents: SocialAgentSnapshot[]): CommitmentCoalitionAssociationEvaluation {
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

export function summarizeCommitmentCoalitionLifecycleTemporalAssociations(
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

export function summarizeNormSanctionLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): NormSanctionLifecycleTemporalAssociationEvaluation {
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

export function summarizeGossipExposureTemporalAssociations(
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

export function summarizeTrustRepairLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairLifecycleTemporalAssociationEvaluation {
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

export function summarizeTrustRepairRelationshipTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairRelationshipTemporalAssociationEvaluation {
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

export function summarizeTrustRepairReputationTemporalAssociations(agents: SocialAgentSnapshot[]): TrustRepairReputationTemporalAssociationEvaluation {
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

export function summarizeBetrayalLifecycleTemporalAssociations(agents: SocialAgentSnapshot[]): BetrayalLifecycleTemporalAssociationEvaluation {
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

