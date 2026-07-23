/** A content-free journal row associated with one exact actor trace. */
export interface DecisionJournalEvidence {
  journalSeq: number;
  turnIndex?: number;
  store: string;
  mutationKind: string;
  subjectId?: string;
  evidenceCount: number;
  messageSeqRange?: [number, number];
  eventSeqRange?: [number, number];
}

/**
 * Build a trace-local journal projection from server-projected agent state.
 * The whitelist deliberately excludes mutation summaries, raw evidence,
 * beliefs, memory content, and arbitrary metadata.
 */
export function buildDecisionJournalEvidence(entries: unknown, actorId: string, traceId: string): DecisionJournalEvidence[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.agentId !== actorId || entry.traceId !== traceId) return [];
      const journalSeq = finiteNumber(entry.journalSeq);
      const store = boundedString(entry.store);
      const mutationKind = boundedString(entry.mutationKind);
      if (journalSeq === undefined || !store || !mutationKind) return [];
      return [
        {
          journalSeq,
          turnIndex: finiteNumber(entry.turnIndex),
          store,
          mutationKind,
          subjectId: boundedString(entry.subjectId),
          evidenceCount: Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs.length : 0,
          messageSeqRange: integerRange(entry.messageSeqRange),
          eventSeqRange: integerRange(entry.eventSeqRange)
        }
      ];
    })
    .sort((left, right) => left.journalSeq - right.journalSeq);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 160 ? value : undefined;
}

function integerRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const start = finiteNumber(value[0]);
  const end = finiteNumber(value[1]);
  return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end)
    ? [start, end]
    : undefined;
}
