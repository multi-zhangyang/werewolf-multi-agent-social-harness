import { z } from "zod";
import type { SocialCausalityProjection } from "./contracts";

const predictedResponseSchema = z.object({
  targetActorId: z.string().min(1).max(160),
  response: z.string().min(1).max(500),
  probability: z.number().min(0).max(1)
}).strict();

export function createStrategyActionShape<T extends z.ZodRawShape>(
  actionShape: T,
  outcomeKeys: readonly [string, ...string[]]
) {
  return {
    referencedEvidenceIds: z.array(z.string().min(1).max(160)).max(8).default([]),
    referencedBeliefIds: z.array(z.string().min(1).max(160)).max(6).default([]),
    referencedActorModelIds: z.array(z.string().min(1).max(160)).max(4).default([]),
    referencedRelationshipIds: z.array(z.string().min(1).max(160)).max(4).default([]),
    candidateIntents: z.array(z.object({
      goal: z.string().min(1).max(400),
      summary: z.string().min(1).max(600),
      publicStrategy: z.string().min(1).max(500).nullable().default(null),
      expectedUtility: z.number().min(-100).max(100).nullable().default(null),
      exposureRisk: z.number().min(0).max(1),
      relationshipRisk: z.number().min(0).max(1),
      predictedResponses: z.array(predictedResponseSchema).max(4).default([]),
      ...actionShape
    }).strict()).min(2).max(4),
    selectedIntentIndex: z.number().int().min(0).max(3),
    predictedConsequences: z.array(z.object({
      outcomeKey: z.enum(outcomeKeys),
      proposition: z.string().min(1).max(500),
      probability: z.number().min(0).max(1),
      horizon: z.enum(["immediate", "round", "game", "future-game"]).default("round")
    }).strict()).min(1).max(6)
  };
}

export function socialReferenceContext(projection: SocialCausalityProjection): string[] {
  const propositions = new Map(projection.propositions.map((entry) => [entry.propositionId, entry]));
  const beliefReferences = projection.beliefUpdates.slice(-6).map((belief) =>
    `${belief.beliefId} -> ${propositionSummary(propositions.get(belief.propositionId))} ` +
    `(p=${belief.afterProbability.toFixed(2)}, confidence=${belief.confidence.toFixed(2)})`
  );
  const actorModelReferences = projection.actorModels.map((model) =>
    `${model.modelId} -> ${model.targetActorId} (` +
    `goals=${model.inferredGoals.slice(0, 2).map((goal) => `${goal.goal}:${goal.probability.toFixed(2)}`).join(", ") || "unknown"}; ` +
    `actions=${model.predictedActions.slice(0, 2).map((action) => `${action.action}:${action.probability.toFixed(2)}`).join(", ") || "unknown"}; ` +
    `honesty=${model.perceivedHonesty.toFixed(2)}, risk=${model.perceivedRiskTolerance.toFixed(2)})`
  );
  const evidenceReferences = projection.evidence.slice(-8).map((evidence) => {
    const proposition = propositions.get(evidence.propositionId);
    return `${evidence.evidenceId} -> ${propositionSummary(proposition)} ` +
      `(${evidence.supports ? "supports" : "contradicts"}; ${evidence.sourceType}` +
      `${evidence.sourceMessageId ? `; message=${evidence.sourceMessageId}` : ""})`;
  });
  const relationshipReferences = projection.directedRelationships.slice(-6).map((relationship) =>
    `${relationship.relationshipId} -> ${relationship.targetActorId} (` +
    `trust=${relationship.trust.toFixed(2)}, affinity=${relationship.affinity.toFixed(2)}, ` +
    `respect=${relationship.respect.toFixed(2)}, tension=${relationship.tension.toFixed(2)})`
  );
  return [
    `Your belief references: ${beliefReferences.join("; ") || "none"}.`,
    `Your actor-model references: ${actorModelReferences.join("; ") || "none"}.`,
    `Your relationship references: ${relationshipReferences.join("; ") || "none"}.`,
    `Your evidence references: ${evidenceReferences.join("; ") || "none"}.`
  ];
}

function propositionSummary(proposition: SocialCausalityProjection["propositions"][number] | undefined): string {
  if (!proposition) return "unknown proposition";
  const subject = proposition.subjectId ? `${proposition.subjectId} ` : "";
  const object = proposition.object === undefined ? "" : ` ${compactValue(proposition.object)}`;
  return `${proposition.propositionId}: ${subject}${proposition.predicate}${object}`;
}

function compactValue(value: unknown): string {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  if (!encoded) return String(value);
  return encoded.length > 180 ? `${encoded.slice(0, 177)}...` : encoded;
}
