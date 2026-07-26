import { average, confidence, countStrings, ratio, sampleIds } from "./episodeData";
import { averageMetric, countMetric, ratioMetric } from "./metricBuilders";
import { agentStateEvidence, evidenceFromBetrayals, evidenceFromCoalitions, evidenceFromCommitments, evidenceFromGossip, evidenceFromNormSanctions, evidenceFromSocialRefs, evidenceFromTrustRepairs, socialSubject } from "./evidence";
import { type HarnessMetricRecord } from "../types";
import { type SocialAgentSnapshot } from "./manifests";
export function metricsForAgent(agent: SocialAgentSnapshot): HarnessMetricRecord[] {
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

