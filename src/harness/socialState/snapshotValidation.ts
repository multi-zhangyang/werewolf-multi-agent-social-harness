import { deterministicTimestamp } from "./recordUtils";
import { type AgentSocialState } from "./contracts";
/**
 * Pure validation for a durable social-state snapshot. Hashes alone only prove
 * that bytes are self-consistent; they do not prove that rolling-window
 * sequence identities are legal. Domain runtimes can add stricter caps through
 * the options without teaching this generic store about a concrete game.
 */
export function validateAgentSocialStateSnapshot(
  state: AgentSocialState,
  options: {
    expectedAgentId?: string;
    maxMemoryEntries?: number;
    maxJournalEntries?: number;
    requireJournal?: boolean;
  } = {}
): string[] {
  const errors: string[] = [];
  if (!state || typeof state !== "object") return ["social state must be an object."];
  if (typeof state.agentId !== "string" || !state.agentId.trim()) errors.push("agentId is required.");
  if (options.expectedAgentId !== undefined && state.agentId !== options.expectedAgentId) {
    errors.push(`agentId mismatch: expected ${options.expectedAgentId}, received ${state.agentId || "<missing>"}.`);
  }

  validateRetainedSequenceWindow({
    label: "memory",
    nextSeq: state.memory?.nextSeq,
    maxEntries: state.memory?.maxEntries,
    entries: state.memory?.entries,
    sequenceOf: (entry) => isObjectRecord(entry) ? entry.seq : undefined,
    createdAtOf: (entry) => isObjectRecord(entry) ? entry.createdAt : undefined,
    maxAllowedEntries: options.maxMemoryEntries,
    errors
  });

  if (!state.journal) {
    if (options.requireJournal) errors.push("journal is required.");
  } else {
    if (state.journal.schemaVersion !== "harness.social-state-journal.v1") {
      errors.push("journal.schemaVersion must be harness.social-state-journal.v1.");
    }
    validateRetainedSequenceWindow({
      label: "journal",
      nextSeq: state.journal.nextSeq,
      maxEntries: state.journal.maxEntries,
      entries: state.journal.entries,
      sequenceOf: (entry) => isObjectRecord(entry) ? entry.journalSeq : undefined,
      createdAtOf: (entry) => isObjectRecord(entry) ? entry.createdAt : undefined,
      maxAllowedEntries: options.maxJournalEntries,
      errors
    });
  }

  if (state.messageIngestion !== undefined) {
    if (state.messageIngestion.schemaVersion !== "harness.social-message-ingestion.v1") {
      errors.push("messageIngestion.schemaVersion must be harness.social-message-ingestion.v1.");
    }
    if (!Array.isArray(state.messageIngestion.seenMessageIds)) {
      errors.push("messageIngestion.seenMessageIds must be an array.");
    } else {
      const seen = new Set<string>();
      for (const [index, messageId] of state.messageIngestion.seenMessageIds.entries()) {
        if (typeof messageId !== "string" || !messageId.trim()) {
          errors.push(`messageIngestion.seenMessageIds[${index}] must be a non-empty string.`);
        } else if (seen.has(messageId)) {
          errors.push(`messageIngestion.seenMessageIds contains duplicate ${messageId}.`);
        }
        seen.add(messageId);
      }
    }
  }
  return errors;
}

function validateRetainedSequenceWindow(input: {
  label: string;
  nextSeq: unknown;
  maxEntries: unknown;
  entries: unknown;
  sequenceOf: (entry: unknown) => unknown;
  createdAtOf: (entry: unknown) => unknown;
  maxAllowedEntries?: number;
  errors: string[];
}): void {
  if (!Number.isInteger(input.maxEntries) || (input.maxEntries as number) < 1) {
    input.errors.push(`${input.label}.maxEntries must be a positive integer.`);
  } else if (input.maxAllowedEntries !== undefined && (input.maxEntries as number) > input.maxAllowedEntries) {
    input.errors.push(`${input.label}.maxEntries exceeds the allowed maximum ${input.maxAllowedEntries}.`);
  }
  if (!Number.isInteger(input.nextSeq) || (input.nextSeq as number) < 1) {
    input.errors.push(`${input.label}.nextSeq must be a positive integer.`);
  }
  if (!Array.isArray(input.entries)) {
    input.errors.push(`${input.label}.entries must be an array.`);
    return;
  }
  if (Number.isInteger(input.maxEntries) && input.entries.length > (input.maxEntries as number)) {
    input.errors.push(`${input.label}.entries exceeds maxEntries.`);
  }
  if (!Number.isInteger(input.nextSeq) || (input.nextSeq as number) < 1) return;
  if (Number.isInteger(input.maxEntries) && (input.maxEntries as number) > 0) {
    const expectedRetainedCount = Math.min(input.maxEntries as number, (input.nextSeq as number) - 1);
    if (input.entries.length !== expectedRetainedCount) {
      input.errors.push(`${input.label}.entries must retain ${expectedRetainedCount} sequence entries.`);
    }
  }
  const expectedFirstSeq = (input.nextSeq as number) - input.entries.length;
  if (expectedFirstSeq < 1) {
    input.errors.push(`${input.label}.nextSeq is smaller than its retained entry window.`);
    return;
  }
  for (const [index, entry] of input.entries.entries()) {
    const sequence = input.sequenceOf(entry);
    const expectedSequence = expectedFirstSeq + index;
    if (!Number.isInteger(sequence) || sequence !== expectedSequence) {
      input.errors.push(`${input.label}.entries[${index}] sequence must be ${expectedSequence}.`);
    }
    const createdAt = input.createdAtOf(entry);
    if (Number.isInteger(sequence) && createdAt !== deterministicTimestamp(sequence as number)) {
      input.errors.push(`${input.label}.entries[${index}].createdAt does not match its sequence.`);
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requirePositiveCapacity(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}
