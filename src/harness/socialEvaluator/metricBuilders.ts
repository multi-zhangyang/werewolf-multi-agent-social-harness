import { confidence } from "./episodeData";
import { socialAgentId, withSocialHash } from "./evidence";
import { metric } from "../evaluation";
import { type HarnessMetricEvidenceRef, type HarnessMetricRecord } from "../types";
import { BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID, COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, SOCIAL_DYNAMICS_EVALUATOR_ID, SOCIAL_STATE_EVALUATOR_ID, type SocialAgentSnapshot, TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID, TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID, TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID } from "./manifests";
export function countMetric(
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

export function ratioMetric(
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

export function averageMetric(
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

export function associationCountMetric(
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

export function associationRatioMetric(
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

export function lifecycleCountMetric(
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

export function lifecycleRatioMetric(
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

export function normSanctionLifecycleCountMetric(
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

export function normSanctionLifecycleRatioMetric(
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

export function gossipExposureTemporalCountMetric(
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

export function gossipExposureTemporalRatioMetric(
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

export function trustRepairLifecycleCountMetric(
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

export function trustRepairLifecycleRatioMetric(
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

export function trustRepairRelationshipTemporalCountMetric(
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

export function trustRepairRelationshipTemporalRatioMetric(
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

export function trustRepairReputationTemporalCountMetric(
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

export function trustRepairReputationTemporalRatioMetric(
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

export function betrayalLifecycleCountMetric(
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

export function betrayalLifecycleRatioMetric(
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

export function lifecycleMetadata(temporalAssociationKind: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
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

export function trustRepairJournalMutationMetadata(temporalAssociationKind: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return lifecycleMetadata(temporalAssociationKind, {
    repairSource: "AgentSocialState.trustRepairs.records",
    subjectMatchRule: "repair_actor_id",
    matchedParticipantRole: "actor",
    ...metadata
  });
}

export function gossipExposureMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
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

export function dynamicsCountMetric(
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

export function dynamicsRatioMetric(
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

