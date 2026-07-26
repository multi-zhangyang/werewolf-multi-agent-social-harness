import { mergeMutationContext, metadataKeys, recordSocialStateMutation, summarizeGoalRecord, summarizeNormRecord, summarizeNumericDeltas, summarizePlan, summarizeRelationshipEdge, summarizeReputationRecord } from "./journal";
import { clamp01, clampSigned, cloneJson, createRelationshipEdge, createReputationRecord, deterministicTimestamp, mergeEvidenceRefs, requireEvidence } from "./recordUtils";
import { type AgentNormState, type AgentSocialState, type EvidenceRef, type GoalRecord, type GoalStack, type GoalStatus, type NormRecord, type NormStatus, type RelationshipEdge, type RelationshipGraph, type ReputationLedger, type ReputationRecord, type SocialStateMutationContext } from "./contracts";
export function updateRelationship(graph: RelationshipGraph, input: {
  targetId: string;
  deltas: Partial<Pick<RelationshipEdge, "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): RelationshipEdge {
  requireEvidence(input.evidenceRefs, "relationship update");
  const previous = graph.edges[input.targetId] ?? createRelationshipEdge(input.targetId);
  const updated: RelationshipEdge = {
    ...previous,
    trust: clampSigned(previous.trust + (input.deltas.trust ?? 0)),
    suspicion: clampSigned(previous.suspicion + (input.deltas.suspicion ?? 0)),
    affinity: clampSigned(previous.affinity + (input.deltas.affinity ?? 0)),
    influence: clampSigned(previous.influence + (input.deltas.influence ?? 0)),
    debt: clampSigned(previous.debt + (input.deltas.debt ?? 0)),
    respect: clampSigned(previous.respect + (input.deltas.respect ?? 0)),
    threat: clampSigned(previous.threat + (input.deltas.threat ?? 0)),
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  graph.edges[input.targetId] = updated;
  return cloneJson(updated);
}

export function updateSocialRelationship(state: AgentSocialState, input: {
  targetId: string;
  deltas: Partial<Pick<RelationshipEdge, "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): RelationshipEdge {
  const previous = state.relationships.edges[input.targetId];
  const updated = updateRelationship(state.relationships, input);
  recordSocialStateMutation(state, {
    store: "relationships",
    mutationKind: "relationship.updated",
    subjectId: input.targetId,
    beforeSummary: previous ? summarizeRelationshipEdge(previous) : undefined,
    afterSummary: summarizeRelationshipEdge(updated),
    deltaSummary: summarizeNumericDeltas(input.deltas),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function updateReputation(ledger: ReputationLedger, input: {
  subjectId: string;
  deltas: Partial<Pick<ReputationRecord, "honesty" | "competence" | "cooperation" | "threat" | "normCompliance">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): ReputationRecord {
  requireEvidence(input.evidenceRefs, "reputation update");
  const previous = ledger.records[input.subjectId] ?? createReputationRecord(input.subjectId);
  const updated: ReputationRecord = {
    ...previous,
    honesty: clampSigned(previous.honesty + (input.deltas.honesty ?? 0)),
    competence: clampSigned(previous.competence + (input.deltas.competence ?? 0)),
    cooperation: clampSigned(previous.cooperation + (input.deltas.cooperation ?? 0)),
    threat: clampSigned(previous.threat + (input.deltas.threat ?? 0)),
    normCompliance: clampSigned(previous.normCompliance + (input.deltas.normCompliance ?? 0)),
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.subjectId] = updated;
  return cloneJson(updated);
}

export function updateSocialReputation(state: AgentSocialState, input: {
  subjectId: string;
  deltas: Partial<Pick<ReputationRecord, "honesty" | "competence" | "cooperation" | "threat" | "normCompliance">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): ReputationRecord {
  const previous = state.reputation.records[input.subjectId];
  const updated = updateReputation(state.reputation, input);
  recordSocialStateMutation(state, {
    store: "reputation",
    mutationKind: "reputation.updated",
    subjectId: input.subjectId,
    beforeSummary: previous ? summarizeReputationRecord(previous) : undefined,
    afterSummary: summarizeReputationRecord(updated),
    deltaSummary: summarizeNumericDeltas(input.deltas),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function addNorm(state: AgentNormState, input: Omit<NormRecord, "createdAt" | "updatedAt">): NormRecord {
  requireEvidence(input.evidenceRefs, "norm update");
  const record: NormRecord = {
    ...cloneJson(input),
    confidence: clamp01(input.confidence),
    createdAt: deterministicTimestamp(Object.keys(state.norms).length + 1),
    updatedAt: deterministicTimestamp(Object.keys(state.norms).length + 1)
  };
  state.norms[record.id] = record;
  return cloneJson(record);
}

export function addSocialNorm(
  state: AgentSocialState,
  input: Omit<NormRecord, "createdAt" | "updatedAt">,
  context?: SocialStateMutationContext
): NormRecord {
  const record = addNorm(state.norms, input);
  recordSocialStateMutation(state, {
    store: "norms",
    mutationKind: "norm.added",
    subjectId: record.id,
    afterSummary: summarizeNormRecord(record),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateNormStatus(state: AgentNormState, input: {
  id: string;
  status: NormStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): NormRecord {
  requireEvidence(input.evidenceRefs, "norm status update");
  const previous = state.norms[input.id];
  if (!previous) throw new Error(`Unknown norm ${input.id}.`);
  const updated: NormRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  state.norms[input.id] = updated;
  return cloneJson(updated);
}

export function updateSocialNormStatus(state: AgentSocialState, input: {
  id: string;
  status: NormStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): NormRecord {
  const previous = state.norms.norms[input.id];
  const updated = updateNormStatus(state.norms, input);
  recordSocialStateMutation(state, {
    store: "norms",
    mutationKind: "norm.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeNormRecord(previous) : undefined,
    afterSummary: summarizeNormRecord(updated),
    deltaSummary: {
      previousStatus: previous?.status,
      nextStatus: updated.status
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function pushGoal(stack: GoalStack, input: Omit<GoalRecord, "createdAt" | "updatedAt" | "status"> & { status?: GoalStatus }): GoalRecord {
  requireEvidence(input.evidenceRefs, "goal update");
  const record: GoalRecord = {
    ...cloneJson(input),
    priority: clamp01(input.priority),
    status: input.status ?? "active",
    createdAt: deterministicTimestamp(stack.goals.length + 1),
    updatedAt: deterministicTimestamp(stack.goals.length + 1)
  };
  stack.goals.push(record);
  stack.goals.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return cloneJson(record);
}

export function pushSocialGoal(
  state: AgentSocialState,
  input: Omit<GoalRecord, "createdAt" | "updatedAt" | "status"> & { status?: GoalStatus },
  context?: SocialStateMutationContext
): GoalRecord {
  const beforeCount = state.goals.goals.length;
  const record = pushGoal(state.goals, input);
  recordSocialStateMutation(state, {
    store: "goals",
    mutationKind: "goal.pushed",
    subjectId: record.id,
    beforeSummary: {
      goalCount: beforeCount
    },
    afterSummary: {
      goalCount: state.goals.goals.length,
      ...summarizeGoalRecord(record)
    },
    deltaSummary: {
      addedGoalId: record.id,
      priority: record.priority,
      status: record.status
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateGoalStatus(stack: GoalStack, input: {
  id: string;
  status: GoalStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): GoalRecord {
  requireEvidence(input.evidenceRefs, "goal status update");
  const index = stack.goals.findIndex((goal) => goal.id === input.id);
  if (index < 0) throw new Error(`Unknown goal ${input.id}.`);
  const previous = stack.goals[index];
  const updated: GoalRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  stack.goals[index] = updated;
  return cloneJson(updated);
}

export function updateSocialGoalStatus(state: AgentSocialState, input: {
  id: string;
  status: GoalStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): GoalRecord {
  const previous = state.goals.goals.find((goal) => goal.id === input.id);
  const updated = updateGoalStatus(state.goals, input);
  recordSocialStateMutation(state, {
    store: "goals",
    mutationKind: "goal.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeGoalRecord(previous) : undefined,
    afterSummary: summarizeGoalRecord(updated),
    deltaSummary: {
      previousStatus: previous?.status,
      nextStatus: updated.status
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}


export function setSocialLastPlan(
  state: AgentSocialState,
  plan: unknown,
  evidenceRefs: EvidenceRef[],
  context?: SocialStateMutationContext,
  metadata?: Record<string, unknown>
): unknown {
  const previous = state.lastPlan;
  state.lastPlan = cloneJson(plan);
  recordSocialStateMutation(state, {
    store: "plan",
    mutationKind: "plan.updated",
    beforeSummary: previous === undefined ? undefined : summarizePlan(previous),
    afterSummary: summarizePlan(plan),
    evidenceRefs,
    context: mergeMutationContext(context, evidenceRefs, metadata),
    metadata: {
      metadataKeys: metadataKeys(metadata)
    }
  });
  return cloneJson(state.lastPlan);
}

export function activeGoals(stack: GoalStack): GoalRecord[] {
  return stack.goals.filter((goal) => goal.status === "active").map(cloneJson);
}
