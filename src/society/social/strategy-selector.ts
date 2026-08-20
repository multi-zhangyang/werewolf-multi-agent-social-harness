import type { CandidateIntent, StrategyProfileSnapshot, StrategySelection } from "./contracts";

type ShadowRecommendation = NonNullable<StrategySelection["shadowRecommendation"]>;

/**
 * Scores the participant's own bounded candidates without binding an action.
 * The values are explicitly self-estimates; this selector cannot read world
 * truth, another participant's private state, or a provider reasoning trace.
 */
export function createShadowStrategyRecommendation(input: {
  candidates: CandidateIntent[];
  agentSelectedIntentId: string;
  strategyProfileSnapshot?: StrategyProfileSnapshot;
}): ShadowRecommendation | undefined {
  if (!input.candidates.length) return undefined;
  const weights = weightsFor(input.strategyProfileSnapshot);
  const scored = input.candidates.map((candidate, index) => {
    const normalizedExpectedUtility = clamp((candidate.expectedUtility ?? 0) / 100, -1, 1);
    const exposurePenalty = clamp(candidate.exposureRisk ?? 0, 0, 1) * weights.exposureRisk;
    const relationshipPenalty = clamp(candidate.relationshipRisk ?? 0, 0, 1) * weights.relationshipRisk;
    const evidenceBonus = candidate.evidenceRefs.length > 0 ? weights.evidence : 0;
    const score = normalizedExpectedUtility * weights.utility - exposurePenalty - relationshipPenalty + evidenceBonus;
    return {
      candidate,
      index,
      score,
      breakdown: { normalizedExpectedUtility, exposurePenalty, relationshipPenalty, evidenceBonus }
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const recommended = scored[0];
  if (!recommended) return undefined;
  return {
    recommendedIntentId: recommended.candidate.intentId,
    agentSelectedIntentId: input.agentSelectedIntentId,
    agreedWithAgent: recommended.candidate.intentId === input.agentSelectedIntentId,
    score: Number(recommended.score.toFixed(6)),
    scoreBreakdown: {
      normalizedExpectedUtility: Number(recommended.breakdown.normalizedExpectedUtility.toFixed(6)),
      exposurePenalty: Number(recommended.breakdown.exposurePenalty.toFixed(6)),
      relationshipPenalty: Number(recommended.breakdown.relationshipPenalty.toFixed(6)),
      evidenceBonus: Number(recommended.breakdown.evidenceBonus.toFixed(6))
    },
    weights,
    estimateSource: "agent-self-report",
    selectorVersion: "bounded-shadow-v1"
  };
}

function weightsFor(snapshot: StrategyProfileSnapshot | undefined): ShadowRecommendation["weights"] {
  const biases = new Set(snapshot?.persona.decisionBiases ?? []);
  const exposureRisk = 0.35 + (biases.has("loss-aversion") ? 0.1 : 0);
  const relationshipRisk = 0.25 + (biases.has("betrayal-hypervigilance") ? 0.1 : 0);
  return {
    utility: 1,
    exposureRisk: Number(exposureRisk.toFixed(2)),
    relationshipRisk: Number(relationshipRisk.toFixed(2)),
    evidence: 0.05
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
