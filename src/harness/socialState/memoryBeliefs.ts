import { mergeMutationContext, recordSocialStateMutation, summarizeBeliefClaim, summarizeMemoryEntry } from "./journal";
import { beliefId, clamp01, cloneJson, deterministicTimestamp, memoryScore, mergeEvidenceRefs, requireEvidence, round3, roundMemoryScore } from "./recordUtils";
import { type AgentSocialState, type BeliefClaim, type BeliefStore, type EvidenceRef, MEMORY_RETRIEVAL_VERSION, type MemoryStore, type MemoryVisibility, REFLECTION_RECORD_VERSION, type RetrievedMemoryContext, type SocialMemoryEntry, type SocialStateMutationContext } from "./contracts";
export function appendMemory<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">
): SocialMemoryEntry<TObservation, TPending, TCommand> {
  const seq = store.nextSeq;
  const evidenceRefs = cloneJson(entry.evidenceRefs ?? []);
  requireEvidence(evidenceRefs, "memory append");
  const record: SocialMemoryEntry<TObservation, TPending, TCommand> = {
    kind: entry.kind ?? "memo",
    source: entry.source ?? "agent",
    visibility: entry.visibility ?? "private",
    observation: cloneJson(entry.observation),
    pendingAction: cloneJson(entry.pendingAction),
    action: cloneJson(entry.action),
    reflection: cloneJson(entry.reflection),
    content: entry.content,
    salience: clamp01(entry.salience ?? 0.5),
    importance: clamp01(entry.importance ?? 0.5),
    evidenceRefs,
    tags: [...(entry.tags ?? [])],
    metadata: cloneJson(entry.metadata),
    seq,
    createdAt: deterministicTimestamp(seq)
  };
  store.entries.push(record);
  store.nextSeq += 1;
  if (store.entries.length > store.maxEntries) {
    store.entries = store.entries.slice(-store.maxEntries);
  }
  return cloneJson(record);
}

export function appendSocialMemory<TObservation, TPending, TCommand>(
  state: AgentSocialState<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">,
  context?: SocialStateMutationContext
): SocialMemoryEntry<TObservation, TPending, TCommand> {
  validateReflectionMemoryBinding(state, entry);
  const beforeCount = state.memory.entries.length;
  const beforeNextSeq = state.memory.nextSeq;
  const record = appendMemory(state.memory, entry);
  recordSocialStateMutation(state, {
    store: "memory",
    mutationKind: "memory.appended",
    subjectId: record.source,
    beforeSummary: {
      entryCount: beforeCount,
      nextSeq: beforeNextSeq
    },
    afterSummary: {
      entryCount: state.memory.entries.length,
      nextSeq: state.memory.nextSeq,
      ...summarizeMemoryEntry(record)
    },
    deltaSummary: {
      appendedSeq: record.seq,
      trimmedEntries: Math.max(0, beforeCount + 1 - state.memory.entries.length)
    },
    evidenceRefs: record.evidenceRefs,
    context: mergeMutationContext(context, record.evidenceRefs, record.metadata),
    metadata: {
      tags: record.tags.slice(0, 12)
    }
  });
  return record;
}

function validateReflectionMemoryBinding<TObservation, TPending, TCommand>(
  state: AgentSocialState<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">
): void {
  if (entry.kind !== "reflection") {
    if (entry.reflection !== undefined) throw new Error("Only reflection memory may carry a ReflectionRecord.");
    return;
  }
  const reflection = entry.reflection;
  if (!reflection) throw new Error("Reflection memory requires a typed ReflectionRecord.");
  if (reflection.version !== REFLECTION_RECORD_VERSION) throw new Error(`ReflectionRecord.version must be ${REFLECTION_RECORD_VERSION}.`);
  if (!reflection.id) throw new Error("ReflectionRecord.id must be non-empty.");
  if (reflection.agentId !== state.agentId) throw new Error(`ReflectionRecord.agentId must match ${state.agentId}.`);
  if (!Number.isInteger(reflection.createdAtTurn) || reflection.createdAtTurn < 0) {
    throw new Error("ReflectionRecord.createdAtTurn must be a non-negative integer.");
  }
  if (!["memory_summary", "belief_revision", "strategy_update", "social_risk", "goal_revision"].includes(reflection.kind)) {
    throw new Error("ReflectionRecord.kind is invalid.");
  }
  if (typeof reflection.content !== "string" || !reflection.content.trim()) throw new Error("ReflectionRecord.content must be non-empty.");
  if (!Number.isFinite(reflection.confidence) || reflection.confidence < 0 || reflection.confidence > 1) {
    throw new Error("ReflectionRecord.confidence must be finite and within [0, 1].");
  }
  if (!["private", "team", "postgame"].includes(reflection.visibility)) throw new Error("ReflectionRecord.visibility is invalid.");
  if (!["policy", "reasoner", "evaluator", "human"].includes(reflection.source)) throw new Error("ReflectionRecord.source is invalid.");
  if (!reflection.evidenceRefs.length || !reflection.evidenceRefs.some((ref) => ref.artifact === "outcome" && ref.traceId)) {
    throw new Error("ReflectionRecord requires committed outcome evidence.");
  }
  if (entry.content !== reflection.content) throw new Error("Reflection memory content must match its ReflectionRecord.");
  if ((entry.visibility ?? "private") !== reflection.visibility) throw new Error("Reflection memory visibility must match its ReflectionRecord.");
  if ((entry.source ?? "agent") !== reflection.source) throw new Error("Reflection memory source must match its ReflectionRecord.");
  if (JSON.stringify(entry.evidenceRefs ?? []) !== JSON.stringify(reflection.evidenceRefs)) {
    throw new Error("Reflection memory evidenceRefs must match its ReflectionRecord.");
  }
  if (state.memory.entries.some((candidate) => candidate.reflection?.id === reflection.id)) {
    throw new Error(`Duplicate ReflectionRecord.id ${reflection.id}.`);
  }
}

export function retrieveMemory<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  options: {
    limit?: number;
    tags?: string[];
    visibility?: MemoryVisibility;
    source?: string;
    text?: string;
  } = {}
): Array<SocialMemoryEntry<TObservation, TPending, TCommand>> {
  const tags = new Set(options.tags ?? []);
  const text = options.text?.toLowerCase();
  const matches = store.entries.filter((entry) => {
    if (options.visibility && entry.visibility !== options.visibility) return false;
    if (options.source && entry.source !== options.source) return false;
    if (tags.size && !entry.tags.some((tag) => tags.has(tag))) return false;
    if (text && !entry.content?.toLowerCase().includes(text)) return false;
    return true;
  });
  return matches
    .sort((a, b) => memoryScore(b) - memoryScore(a) || b.seq - a.seq)
    .slice(0, options.limit ?? matches.length)
    .map(cloneJson);
}

/**
 * Read a bounded, deterministic selection from one actor's memory without
 * changing the store or journal.  Consumers receive cloned entries for
 * private policy/reasoner context and a content-free evidence record suitable
 * for plans, receipts, snapshots, and artifacts.
 */
export function retrieveMemoryContext<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  options: {
    actorId: string;
    traceId?: string;
    limit?: number;
    tags?: string[];
    visibility?: MemoryVisibility;
    source?: string;
  }
): RetrievedMemoryContext<TObservation, TPending, TCommand> {
  const limit = Math.max(0, Math.floor(options.limit ?? store.entries.length));
  const entries = retrieveMemory(store, {
    limit,
    tags: options.tags,
    visibility: options.visibility,
    source: options.source
  });
  return {
    evidence: {
      version: MEMORY_RETRIEVAL_VERSION,
      actorId: options.actorId,
      traceId: options.traceId,
      query: {
        limit,
        tags: options.tags ? [...options.tags] : undefined,
        visibility: options.visibility,
        source: options.source,
        ranking: "importance_then_salience_then_recency"
      },
      selected: entries.map((entry, index) => ({
        memorySeq: entry.seq,
        rank: index + 1,
        score: roundMemoryScore(memoryScore(entry)),
        scoreReasons: ["importance", "salience", "recency_tiebreak"],
        kind: entry.kind,
        source: entry.source,
        visibility: entry.visibility,
        tags: [...entry.tags],
        evidenceRefs: cloneJson(entry.evidenceRefs)
      }))
    },
    entries: cloneJson(entries)
  };
}

export function upsertBelief(store: BeliefStore, input: {
  subject: string;
  predicate: string;
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): BeliefClaim {
  requireEvidence(input.evidenceRefs, "belief update");
  const id = beliefId(input.subject, input.predicate);
  const previous = store.claims[id];
  const contradictions = [...(previous?.contradictions ?? [])];
  if (previous && JSON.stringify(previous.value) !== JSON.stringify(input.value)) {
    contradictions.push({
      value: cloneJson(previous.value),
      confidence: previous.confidence,
      evidenceRefs: cloneJson(previous.evidenceRefs),
      createdAt: deterministicTimestamp(contradictions.length + 1)
    });
  }
  const record: BeliefClaim = {
    id,
    subject: input.subject,
    predicate: input.predicate,
    value: cloneJson(input.value),
    confidence: clamp01(input.confidence),
    evidenceRefs: mergeEvidenceRefs(previous?.evidenceRefs ?? [], input.evidenceRefs),
    contradictions,
    updatedAt: deterministicTimestamp((previous?.evidenceRefs.length ?? 0) + input.evidenceRefs.length + contradictions.length + 1),
    metadata: cloneJson(input.metadata)
  };
  store.claims[id] = record;
  return cloneJson(record);
}

export function upsertSocialBelief(state: AgentSocialState, input: {
  subject: string;
  predicate: string;
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): BeliefClaim {
  const id = beliefId(input.subject, input.predicate);
  const previous = state.beliefs.claims[id];
  const record = upsertBelief(state.beliefs, input);
  recordSocialStateMutation(state, {
    store: "beliefs",
    mutationKind: "belief.upserted",
    subjectId: input.subject,
    beforeSummary: previous ? summarizeBeliefClaim(previous) : undefined,
    afterSummary: summarizeBeliefClaim(record),
    deltaSummary: {
      claimId: id,
      predicate: input.predicate,
      valueChanged: previous ? JSON.stringify(previous.value) !== JSON.stringify(input.value) : true,
      confidenceDelta: round3(record.confidence - (previous?.confidence ?? 0)),
      contradictionCountDelta: record.contradictions.length - (previous?.contradictions.length ?? 0)
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}
