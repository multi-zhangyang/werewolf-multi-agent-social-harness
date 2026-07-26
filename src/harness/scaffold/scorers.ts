import type {
  BeliefClaim,
  BetrayalKind,
  BetrayalRecord,
  BetrayalStatus,
  CoalitionRecord,
  CoalitionStatus,
  CommitmentRecord,
  CommitmentStatus,
  EvidenceRef,
  GoalRecord,
  GossipRecord,
  GossipValence,
  NormSanctionKind,
  NormSanctionRecord,
  NormSanctionStatus,
  NormRecord,
  RelationshipEdge,
  ReputationRecord,
  TrustRepairKind,
  TrustRepairRecord,
  TrustRepairStatus
} from "../socialState";
import { addScore, cloneJson, finiteNumber, numericScore, round3, uniqueEvidence, uniqueStrings } from "./internals";
import {
  WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
  type AgentActionCandidateScorer,
  type AgentActionCandidateScorerConfig,
  type AgentActionCandidateScorerRegistry,
  type AgentRelationshipScoreField,
  type AgentReputationScoreField,
  type WeightedSocialStateCandidateScorerOptions
} from "./types";

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
        const relationship = input.social.relationships.edges[targetId];
        if (relationship) {
          const contribution = weightedRelationshipContribution(relationship, options.relationshipWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...relationship.evidenceRefs);
        }
        const reputation = input.social.reputation.records[targetId];
        if (reputation) {
          const contribution = weightedReputationContribution(reputation, options.reputationWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...reputation.evidenceRefs);
        }
        for (const claim of Object.values(input.social.beliefs.claims).filter((item) => item.subject === targetId)) {
          const contribution = weightedBeliefContribution(claim, options.beliefPredicateWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...claim.evidenceRefs);
        }
        if (options.activeGoalWeight) {
          for (const goal of input.social.goals.goals.filter((item) => item.status === "active" && socialRecordTargets(item, targetId))) {
            delta += goal.priority * options.activeGoalWeight;
            reasons.push(`goal:${goal.kind}`);
            evidenceRefs.push(...goal.evidenceRefs);
          }
        }
        if (options.activeNormWeight) {
          for (const norm of Object.values(input.social.norms.norms).filter((item) => item.status === "active" && socialRecordTargets(item, targetId))) {
            delta += norm.confidence * options.activeNormWeight;
            reasons.push(`norm:${norm.kind}`);
            evidenceRefs.push(...norm.evidenceRefs);
          }
        }
        for (const commitment of Object.values(input.social.commitments?.records ?? {}).filter((item) =>
          commitmentTargets(item, targetId)
        )) {
          const contribution = weightedCommitmentContribution(commitment, options.commitmentStatusWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...commitment.evidenceRefs);
        }
        for (const coalition of Object.values(input.social.coalitions?.records ?? {}).filter((item) =>
          coalitionTargets(item, targetId)
        )) {
          const contribution = weightedCoalitionContribution(coalition, options.coalitionStatusWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...coalition.evidenceRefs);
        }
        for (const gossip of Object.values(input.social.gossip?.records ?? {}).filter((item) => gossipTargets(item, targetId))) {
          const contribution = weightedGossipContribution(gossip, options.gossipValenceWeights ?? {});
          delta += contribution.delta;
          reasons.push(...contribution.reasons);
          evidenceRefs.push(...gossip.evidenceRefs);
        }
        for (const sanction of Object.values(input.social.normSanctions?.records ?? {}).filter((item) =>
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
        for (const repair of Object.values(input.social.trustRepairs?.records ?? {}).filter((item) =>
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
        for (const betrayal of Object.values(input.social.betrayals?.records ?? {}).filter((item) =>
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

export function weightedRelationshipContribution(
  relationship: RelationshipEdge,
  weights: Partial<Record<AgentRelationshipScoreField, number>>
): { delta: number; reasons: string[] } {
  const fields: AgentRelationshipScoreField[] = ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"];
  return weightedNumericContribution(relationship, fields, weights, "relationship");
}

export function weightedReputationContribution(
  reputation: ReputationRecord,
  weights: Partial<Record<AgentReputationScoreField, number>>
): { delta: number; reasons: string[] } {
  const fields: AgentReputationScoreField[] = ["honesty", "competence", "cooperation", "threat", "normCompliance"];
  return weightedNumericContribution(reputation, fields, weights, "reputation");
}

export function weightedNumericContribution<TField extends string>(
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

export function weightedBeliefContribution(claim: BeliefClaim, weights: Record<string, number>): { delta: number; reasons: string[] } {
  const weight = weights[claim.predicate];
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { delta: 0, reasons: [] };
  const valueScore = beliefValueScore(claim.value);
  if (valueScore === undefined) return { delta: 0, reasons: [] };
  const delta = round3(valueScore * claim.confidence * weight);
  return delta === 0 ? { delta: 0, reasons: [] } : { delta, reasons: [`belief:${claim.predicate}`] };
}

export function beliefValueScore(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : -1;
  return undefined;
}

export function weightedCommitmentContribution(
  commitment: CommitmentRecord,
  statusWeights: Partial<Record<CommitmentStatus, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(commitment.status, commitment.confidence, statusWeights, "commitment");
}

export function weightedCoalitionContribution(
  coalition: CoalitionRecord,
  statusWeights: Partial<Record<CoalitionStatus, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(coalition.status, coalition.confidence, statusWeights, "coalition");
}

export function weightedGossipContribution(
  gossip: GossipRecord,
  valenceWeights: Partial<Record<GossipValence, number>>
): { delta: number; reasons: string[] } {
  return weightedCategoricalContribution(gossip.valence, gossip.confidence, valenceWeights, "gossip");
}

export function weightedNormSanctionContribution(
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

export function weightedTrustRepairContribution(
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

export function weightedBetrayalContribution(
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

export function normalizeAgentActionCandidateScorerConfig(value: unknown, index: number): AgentActionCandidateScorerConfig {
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

export function normalizeWeightedSocialStateCandidateScorerOptions(
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

export function normalizeWeightMap<TValue extends string>(
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

export function normalizeOpenWeightMap(value: unknown, path: string): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`${path} keys must be non-empty strings.`);
    output[key] = numberOption(entry, `${path}.${key}`);
  }
  return output;
}

export function optionalStringOption(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${path} must be a non-empty string.`);
  return normalized;
}

export function optionalNumberOption(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return numberOption(value, path);
}

export function numberOption(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

export function assertOnlyKeys(record: Record<string, unknown>, path: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`);
  }
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function weightedCategoricalContribution<TValue extends string>(
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

export function combineContributions(contributions: Array<{ delta: number; reasons: string[] }>): { delta: number; reasons: string[] } {
  return {
    delta: round3(contributions.reduce((sum, contribution) => sum + contribution.delta, 0)),
    reasons: uniqueStrings(contributions.flatMap((contribution) => contribution.reasons))
  };
}

export function socialRecordTargets(record: GoalRecord | NormRecord, targetId: string): boolean {
  const metadata = record.metadata;
  return metadataTargets(metadata, targetId);
}

export function commitmentTargets(record: CommitmentRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

export function coalitionTargets(record: CoalitionRecord, targetId: string): boolean {
  return record.targetId === targetId || record.memberIds.includes(targetId) || metadataTargets(record.metadata, targetId);
}

export function gossipTargets(record: GossipRecord, targetId: string): boolean {
  return record.subjectId === targetId || metadataTargets(record.metadata, targetId);
}

export function normSanctionTargets(record: NormSanctionRecord, targetId: string): boolean {
  return record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

export function trustRepairTargets(record: TrustRepairRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

export function betrayalTargets(record: BetrayalRecord, targetId: string): boolean {
  return record.actorId === targetId || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

export function metadataTargets(metadata: Record<string, unknown> | undefined, targetId: string): boolean {
  if (!metadata) return false;
  if (metadata.targetId === targetId) return true;
  return Array.isArray(metadata.targetIds) && metadata.targetIds.some((item) => item === targetId);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
