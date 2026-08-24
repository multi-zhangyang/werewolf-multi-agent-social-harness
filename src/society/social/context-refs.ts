import { setSensitiveDataLoggingEnabled } from "@openai/agents";
import type { SocialCausalityProjection } from "./contracts";

// The SDK redacts tool data from validation errors by default, which leaves
// parse-failure feedback with no field details for the model to repair. Our
// own safe summaries (safeInputSummary/safeOutputSummary) are the privacy
// boundary for logs and UI; enabling SDK error details only enriches the
// retry hint the model receives.
setSensitiveDataLoggingEnabled(true);

/**
 * Parse-time validation feedback for Society tools. The SDK default reports a
 * bare "invalid input" with no specifics, which leaves the model guessing and
 * burning retries on the same malformed arguments. This surfaces the failing
 * fields and their legal values so any model can repair its own call.
 */
export function toolArgumentFeedback(toolName: string): (context: unknown, error: unknown) => string {
  return (_context, error) => {
    const original = (error as { originalError?: { message?: unknown } } | null | undefined)?.originalError;
    if (typeof original === "object" && original !== null && typeof original.message === "string") {
      return [
        `The arguments for ${toolName} were rejected by schema validation.`,
        "Fix the listed fields and call the tool again.",
        `Validation details: ${original.message.slice(0, 600)}`
      ].join(" ");
    }
    const details = error instanceof Error ? error.toString() : String(error);
    return `An error occurred while running the tool. Please try again. Error: ${details.slice(0, 600)}`;
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