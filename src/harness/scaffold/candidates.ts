import type { SocialAction } from "../social";
import { addScore, cloneJson, finiteNumber, numericScore, uniqueEvidence, uniqueStrings } from "./internals";
import type {
  AgentActionArbitrationDecision,
  AgentActionArbitrationSummary,
  AgentActionCandidate,
  AgentActionCandidateScoreContribution,
  AgentActionCandidateSummary,
  AgentReasonerOutput
} from "./types";

export function candidateFromPolicyAction<TCommand>(actorId: string, policyId: string, action: SocialAction<TCommand>): AgentActionCandidate<TCommand> {
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

export function normalizeAgentReasonerOutput<TAdvice>(
  value: string | AgentReasonerOutput<TAdvice> | undefined
): AgentReasonerOutput<TAdvice> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { memo: value };
  return {
    memo: value.memo,
    advice: cloneJson(value.advice)
  };
}

export function normalizeCandidates<TCommand>(actorId: string, candidates: Array<AgentActionCandidate<TCommand>>): Array<AgentActionCandidate<TCommand>> {
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

export function normalizeScoreContribution(scorerId: string, contribution: AgentActionCandidateScoreContribution): AgentActionCandidateScoreContribution {
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

export function applyScoreContribution<TCommand>(
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

export function defaultActionArbitrationDecision<TCommand>(candidates: Array<AgentActionCandidate<TCommand>>): AgentActionArbitrationDecision {
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

export function buildArbitrationSummary<TCommand>(options: {
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

export function candidateSummary<TCommand>(candidate: AgentActionCandidate<TCommand>): AgentActionCandidateSummary {
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

export function withArbitrationMetadata<TCommand>(
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

