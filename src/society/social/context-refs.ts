import type { SocialCausalityProjection } from "./contracts";

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
    `Your evidence references: ${evidenceReferences.join("; ") || "none"}.`,
    ...(publicReputation(projection) ? [publicReputation(projection)!] : [])
  ];
}

/**
 * Publicly settled reputation per character: claims the world has falsified
 * plus commitments settled as violated. It reaches the agent as plain context
 * — how much to trust someone stays the model's own judgment in the agent
 * loop; this never edits beliefs mechanically.
 */
function publicReputation(projection: SocialCausalityProjection): string | undefined {
  const propositions = new Map(projection.propositions.map((entry) => [entry.propositionId, entry]));
  const falsified = new Map<string, number>();
  for (const act of projection.socialActs) {
    const caught = act.propositionIds.filter((id) => propositions.get(id)?.truthStatus === "false").length;
    if (caught > 0) falsified.set(act.actorCharacterId, (falsified.get(act.actorCharacterId) ?? 0) + caught);
  }
  const broken = new Map<string, number>();
  for (const commitment of projection.commitments) {
    if (commitment.state === "violated") {
      broken.set(commitment.promisorCharacterId, (broken.get(commitment.promisorCharacterId) ?? 0) + 1);
    }
  }
  const entries = [...new Set([...falsified.keys(), ...broken.keys()])]
    .map((characterId) => {
      const parts: string[] = [];
      if (falsified.get(characterId)) parts.push(`${falsified.get(characterId)} falsified claim${falsified.get(characterId)! > 1 ? "s" : ""}`);
      if (broken.get(characterId)) parts.push(`${broken.get(characterId)} broken commitment${broken.get(characterId)! > 1 ? "s" : ""}`);
      return `${characterId}: ${parts.join(" and ")}`;
    });
  if (!entries.length) return undefined;
  return `Publicly settled reputation (world-falsified claims and violated commitments — weigh it yourself): ${entries.join("; ")}.`;
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
