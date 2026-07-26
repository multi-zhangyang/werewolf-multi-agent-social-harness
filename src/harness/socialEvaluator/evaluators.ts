import { socialAgentId } from "./evidence";
import { socialFactIngestEvidenceMetricsForAgent } from "./factIngest";
import { exposureRecordsFromSocialEpisode, groupExposureRecordsByObserver, messagesFromSocialEpisode, socialMessageIndex } from "./episodeData";
import { betrayalLifecycleTemporalMetricsForAgent, commitmentCoalitionAssociationMetricsForAgent, commitmentCoalitionLifecycleTemporalMetricsForAgent, dynamicsMetricsForAgent, exposureMetricsForAgent, gossipExposureTemporalMetricsForAgent, normSanctionLifecycleTemporalMetricsForAgent, trustRepairLifecycleTemporalMetricsForAgent, trustRepairRelationshipTemporalMetricsForAgent, trustRepairReputationTemporalMetricsForAgent } from "./agentMetricFamilies";
import { metricsForAgent } from "./stateMetrics";
import { summarizeBetrayalLifecycleTemporalAssociations, summarizeCommitmentCoalitionAssociations, summarizeCommitmentCoalitionLifecycleTemporalAssociations, summarizeGossipExposureTemporalAssociations, summarizeNormSanctionLifecycleTemporalAssociations, summarizeSocialDynamics, summarizeSocialFactIngestEvidence, summarizeSocialState, summarizeTrustRepairLifecycleTemporalAssociations, summarizeTrustRepairRelationshipTemporalAssociations, summarizeTrustRepairReputationTemporalAssociations } from "./summaries";
import { type HarnessEvaluationModuleResult, type HarnessMetricRecord } from "../types";
import { BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, type BetrayalLifecycleTemporalAssociationEvaluation, COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID, COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_MANIFEST, COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, type CommitmentCoalitionAssociationEvaluation, type CommitmentCoalitionLifecycleTemporalAssociationEvaluation, GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, type GossipExposureTemporalAssociationEvaluation, NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, type NormSanctionLifecycleTemporalAssociationEvaluation, SOCIAL_DYNAMICS_EVALUATOR_ID, SOCIAL_DYNAMICS_EVALUATOR_MANIFEST, SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID, SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_MANIFEST, SOCIAL_STATE_EVALUATOR_ID, SOCIAL_STATE_EVALUATOR_MANIFEST, type SocialAgentSnapshot, type SocialDynamicsEvaluation, type SocialEvaluationContext, type SocialEvaluator, type SocialFactIngestEvidenceEvaluation, type SocialStateEvaluation, TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID, TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID, TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_MANIFEST, type TrustRepairLifecycleTemporalAssociationEvaluation, type TrustRepairRelationshipTemporalAssociationEvaluation, type TrustRepairReputationTemporalAssociationEvaluation } from "./manifests";
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
