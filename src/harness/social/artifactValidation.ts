import { asRecord, stringMetadata } from "./valueUtils";
import { extractObservedSocialMessages, findCommittedMessageByIndexes, isSeqRange, validateDeliveryReceipts, validateMessageEnvelope, validateSeqRange, validateSpeechActs } from "./messageValidation";
import { normalizeRuntimeActorBindings, normalizeRuntimeActorIds, runtimeActorProfileIdentityHash, socialProfileIdentityHash, validateSocialAssignmentResolutionEvidence } from "./runtimeBindings";
import { messageVisibleToObserver } from "./visibility";
import { deriveSocialExposureRecords, isSocialStepCommitted, isSocialStepNonReplayableFailure, summarizeSocialExposureRecords } from "./exposure";
import { hashStableState } from "../hash";
import { validateSocialDomainAdapterManifest } from "../domainAdapter";
import { SOCIAL_REASONER_CALL_EVIDENCE_VERSION, type SocialChannel, type SocialEpisodeArtifact, type SocialHarnessStep, type SocialMessage } from "./contracts";
export function validateSocialEpisodeArtifact<TState, TObservation, TPending, TCommand>(
  episode: Pick<
    SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>,
    | "domainId"
    | "domainAdapter"
    | "channels"
    | "steps"
    | "messages"
    | "runtimeActorIds"
    | "runtimeActors"
    | "assignmentResolution"
    | "profiles"
    | "execution"
    | "exposureRecords"
    | "exposureSummary"
  >
): string[] {
  const errors: string[] = [];
  if (episode.domainAdapter) {
    errors.push(...validateSocialDomainAdapterManifest(episode.domainAdapter));
    if (episode.domainId !== episode.domainAdapter.domainId) {
      errors.push("domainId must match domainAdapter.domainId when adapter provenance is recorded.");
    }
  }
  const decisionTimeoutMs = episode.execution?.decisionTimeoutMs;
  if (decisionTimeoutMs !== undefined && (!Number.isInteger(decisionTimeoutMs) || decisionTimeoutMs <= 0)) {
    errors.push("execution.decisionTimeoutMs must be a positive integer when recorded.");
  }
  const maxTransitions = episode.execution?.maxTransitions;
  if (maxTransitions !== undefined && (!Number.isInteger(maxTransitions) || maxTransitions < 0)) {
    errors.push("execution.maxTransitions must be a nonnegative integer when recorded.");
  }
  const reasonerExecutionClass = episode.execution?.reasonerExecutionClass;
  if (
    reasonerExecutionClass !== undefined &&
    reasonerExecutionClass !== "live-provider" &&
    reasonerExecutionClass !== "policy-only" &&
    reasonerExecutionClass !== "injected-unverified"
  ) {
    errors.push(
      "execution.reasonerExecutionClass must be live-provider, policy-only, or injected-unverified when recorded."
    );
  }
  const runtimeActorIds = normalizeRuntimeActorIds(episode.runtimeActorIds, errors, "runtimeActorIds");
  const runtimeActorIdSet = runtimeActorIds ? new Set(runtimeActorIds) : undefined;
  const runtimeActors = normalizeRuntimeActorBindings(episode.runtimeActors, errors, "runtimeActors");
  if (runtimeActors && runtimeActorIds) {
    const boundActorIds = runtimeActors.map(({ actorId }) => actorId);
    if (hashStableState(boundActorIds) !== hashStableState(runtimeActorIds)) {
      errors.push("runtimeActors actor ids must exactly match runtimeActorIds.");
    }
  }
  if (runtimeActors) {
    const boundProfiles = runtimeActors.map(runtimeActorProfileIdentityHash).sort();
    const recordedProfiles = episode.profiles.map(socialProfileIdentityHash).sort();
    if (hashStableState(boundProfiles) !== hashStableState(recordedProfiles)) {
      errors.push("runtimeActors profile identities must exactly match profiles.");
    }
  }
  if (episode.assignmentResolution !== undefined) {
    validateSocialAssignmentResolutionEvidence(episode.assignmentResolution, errors, "assignmentResolution");
  }
  const channelsById = new Map<string, SocialChannel>();
  for (const [index, channel] of episode.channels.entries()) {
    if (!channel.id.trim()) {
      errors.push(`channels[${index}] is missing id.`);
      continue;
    }
    if (channelsById.has(channel.id)) errors.push(`Duplicate social channel id ${channel.id}.`);
    channelsById.set(channel.id, channel);
  }

  const messagesById = new Map<string, SocialMessage>();
  const messagesBySeq = new Map<number, SocialMessage>();
  for (const [index, message] of episode.messages.entries()) {
    const expectedSeq = index + 1;
    if (message.seq !== expectedSeq) {
      errors.push(`messages[${index}] sequence mismatch: expected ${expectedSeq}, received ${message.seq}.`);
    }
    if (!message.id.trim()) {
      errors.push(`messages[${index}] is missing id.`);
    } else if (messagesById.has(message.id)) {
      errors.push(`Duplicate social message id ${message.id}.`);
    }
    if (messagesBySeq.has(message.seq)) errors.push(`Duplicate social message seq ${message.seq}.`);
    messagesById.set(message.id, message);
    messagesBySeq.set(message.seq, message);
    validateMessageEnvelope(message, channelsById, `messages[${index}]`, errors, runtimeActorIdSet);
    validateSpeechActs(message, `messages[${index}]`, errors);
    validateDeliveryReceipts(message, channelsById, `messages[${index}]`, errors, runtimeActorIds);
  }

  const stepsByTraceId = new Map<string, SocialHarnessStep<TObservation, TPending, TCommand>>();
  const reasonerCallIds = new Set<string>();
  for (const [index, step] of episode.steps.entries()) {
    if (!step.traceId.trim()) {
      errors.push(`steps[${index}] is missing traceId.`);
    } else if (stepsByTraceId.has(step.traceId)) {
      errors.push(`Duplicate social step traceId ${step.traceId}.`);
    }
    stepsByTraceId.set(step.traceId, step);
    for (const [callIndex, call] of (step.reasonerCalls ?? []).entries()) {
      const label = `steps[${index}].reasonerCalls[${callIndex}]`;
      errors.push(...validateSocialReasonerCallEvidence(call, {
        label,
        actorId: step.actorId,
        profileId: step.profileId,
        traceId: step.traceId
      }));
      if (reasonerCallIds.has(call.callId)) errors.push(`${label}.callId duplicates ${call.callId}.`);
      reasonerCallIds.add(call.callId);
    }
    validateSeqRange(step.messageSeqRange, messagesBySeq, `steps[${index}].messageSeqRange`, errors);

    // A recorded roster is a run identity boundary. System transitions are
    // runner-owned control records; every other step must remain attributable
    // to a durable actor from that roster.
    if (runtimeActorIdSet && step.actorId !== "system" && !runtimeActorIdSet.has(step.actorId)) {
      errors.push(`steps[${index}].actorId ${step.actorId} is not in the runtime actor roster.`);
    }

    if (step.action.actorId !== step.actorId) {
      errors.push(
        `steps[${index}].action.actorId ${step.action.actorId} does not match scheduled actor ${step.actorId}.`
      );
    }
    for (const [messageIndex, message] of (step.action.messages ?? []).entries()) {
      if (message.senderId !== step.actorId) {
        errors.push(
          `steps[${index}].action.messages[${messageIndex}].senderId ${message.senderId} does not match scheduled actor ${step.actorId}.`
        );
      }
    }
    if (isSocialStepNonReplayableFailure(step)) {
      errors.push(`steps[${index}] records an environment_non_atomic_failure and cannot be replayed as a valid artifact.`);
    }
    if (
      !isSocialStepCommitted(step) &&
      step.preStateHash !== undefined &&
      step.postStateHash !== undefined &&
      step.preStateHash !== step.postStateHash
    ) {
      errors.push(`steps[${index}] rejected step changed domain state hash ${step.preStateHash} -> ${step.postStateHash}.`);
    }

    if (step.messageSeqRange && isSeqRange(step.messageSeqRange)) {
      const [start, end] = step.messageSeqRange;
      for (let seq = start; seq <= end; seq += 1) {
        const message = messagesBySeq.get(seq);
        const messageTraceId = stringMetadata(asRecord(message?.metadata)?.traceId);
        if (messageTraceId && messageTraceId !== step.traceId) {
          errors.push(`steps[${index}].messageSeqRange includes message seq ${seq} from trace ${messageTraceId}, expected ${step.traceId}.`);
        }
      }
    }

    const observed = extractObservedSocialMessages(step);
    if (!observed) continue;
    // Social visibility is scoped to the actor whose decision this receipt
    // records. Without this binding, a forged artifact could attach B's
    // private observation to A's decision step and pass channel visibility
    // checks as though A had received it.
    if (observed.observerId !== step.actorId) {
      errors.push(
        `steps[${index}] observation observerId ${observed.observerId} does not match scheduled actor ${step.actorId}.`
      );
    }
    for (const observedMessage of observed.messages) {
      const committed = findCommittedMessageByIndexes(messagesById, messagesBySeq, observedMessage);
      if (!committed) {
        errors.push(
          `steps[${index}] observation for ${observed.observerId} references uncommitted social message ${observedMessage.id}/${observedMessage.seq}.`
        );
        continue;
      }
      if (committed.id !== observedMessage.id) {
        errors.push(`steps[${index}] observation message id mismatch for seq ${observedMessage.seq}: ${observedMessage.id} !== ${committed.id}.`);
      }
      if (committed.seq !== observedMessage.seq) {
        errors.push(`steps[${index}] observation message seq mismatch for ${observedMessage.id}: ${observedMessage.seq} !== ${committed.seq}.`);
      }
      if (!messageVisibleToObserver(committed, observed.observerId, channelsById, runtimeActorIdSet)) {
        errors.push(`steps[${index}] observation for ${observed.observerId} includes non-visible social message ${committed.id}/${committed.seq}.`);
      }
    }
  }

  const canonicalExposureRecords = deriveSocialExposureRecords(episode);
  for (const exposure of canonicalExposureRecords) {
    if (!messagesById.has(exposure.messageId)) errors.push(`social exposure references unknown message ${exposure.messageId}.`);
    if (!stepsByTraceId.has(exposure.observedAtTraceId)) errors.push(`social exposure references unknown trace ${exposure.observedAtTraceId}.`);
    for (const evidenceRef of exposure.evidenceRefs) {
      if (evidenceRef.artifact === "message" && evidenceRef.id && !messagesById.has(evidenceRef.id)) {
        errors.push(`social exposure evidence references unknown message ${evidenceRef.id}.`);
      }
      if ((evidenceRef.artifact === "trace" || evidenceRef.artifact === "observation") && evidenceRef.traceId && !stepsByTraceId.has(evidenceRef.traceId)) {
        errors.push(`social exposure evidence references unknown trace ${evidenceRef.traceId}.`);
      }
    }
  }

  // A stored sidecar is an optional cache for export/query performance only.
  // It must never become a second, caller-controlled source of social
  // knowledge or evaluation evidence. Artifacts written before this field
  // existed remain valid when both sidecar fields are absent.
  if (episode.exposureRecords !== undefined) {
    if (!Array.isArray(episode.exposureRecords)) {
      errors.push("exposureRecords must be an array when present.");
    } else if (!sameCanonicalSocialExposureValue(episode.exposureRecords, canonicalExposureRecords)) {
      errors.push("exposureRecords do not match canonical scoped-observation exposure evidence.");
    }
  }
  if (episode.exposureSummary !== undefined) {
    const canonicalSummary = summarizeSocialExposureRecords(canonicalExposureRecords);
    if (!sameCanonicalSocialExposureValue(episode.exposureSummary, canonicalSummary)) {
      errors.push("exposureSummary does not match canonical scoped-observation exposure evidence.");
    }
  }

  errors.push(...validateSocialParallelBatchLayout(episode.steps));

  return errors;
}

export function validateSocialReasonerCallEvidence(
  input: unknown,
  expected?: { label?: string; actorId?: string; profileId?: string; model?: string; traceId?: string }
): string[] {
  const label = expected?.label ?? "reasonerCall";
  if (!isReasonerEvidenceRecord(input)) return [`${label} must be an object.`];
  const allowed = new Set([
    "schemaVersion",
    "callId",
    "traceId",
    "actorId",
    "profileId",
    "model",
    "outcome",
    "latencyMs",
    "attempts",
    "usage",
    "retryHistory",
    "stream",
    "failure"
  ]);
  const errors = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `${label} contains unknown field ${key}.`);
  if (input.schemaVersion !== SOCIAL_REASONER_CALL_EVIDENCE_VERSION) {
    errors.push(`${label}.schemaVersion must be ${SOCIAL_REASONER_CALL_EVIDENCE_VERSION}.`);
  }
  for (const field of ["callId", "traceId", "actorId", "profileId", "model"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) errors.push(`${label}.${field} must be a nonempty string.`);
  }
  if (expected?.actorId !== undefined && input.actorId !== expected.actorId) errors.push(`${label}.actorId must match its native step.`);
  if (expected?.profileId !== undefined && input.profileId !== expected.profileId) errors.push(`${label}.profileId must match its native step.`);
  if (expected?.model !== undefined && input.model !== expected.model) errors.push(`${label}.model must match its runtime actor binding.`);
  if (expected?.traceId !== undefined && input.traceId !== expected.traceId) errors.push(`${label}.traceId must match its native step.`);
  errors.push(...validateReasonerCallReport(input, label));
  return errors;
}

export function validateReasonerCallReport(input: unknown, label: string): string[] {
  if (!isReasonerEvidenceRecord(input)) return [`${label} must be an object.`];
  const allowed = new Set([
    "schemaVersion",
    "callId",
    "traceId",
    "actorId",
    "profileId",
    "model",
    "outcome",
    "latencyMs",
    "attempts",
    "usage",
    "retryHistory",
    "stream",
    "failure"
  ]);
  const errors = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `${label} contains unknown field ${key}.`);
  const outcome = input.outcome;
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "aborted") {
    errors.push(`${label}.outcome must be completed, failed, or aborted.`);
  }
  if (input.latencyMs !== undefined && (!Number.isFinite(input.latencyMs) || Number(input.latencyMs) < 0)) {
    errors.push(`${label}.latencyMs must be a finite nonnegative number when recorded.`);
  }
  if (input.attempts !== undefined && (!Number.isInteger(input.attempts) || Number(input.attempts) <= 0)) {
    errors.push(`${label}.attempts must be a positive integer when recorded.`);
  }
  if (outcome === "completed" && input.latencyMs === undefined) errors.push(`${label}.latencyMs is required for a completed call.`);
  if (outcome === "completed" && input.attempts === undefined) errors.push(`${label}.attempts is required for a completed call.`);
  errors.push(...validateReasonerCallUsage(input.usage, `${label}.usage`));
  errors.push(...validateReasonerRetryHistory(input.retryHistory, `${label}.retryHistory`));
  const stream = isReasonerEvidenceRecord(input.stream) ? input.stream : undefined;
  if (!stream) {
    errors.push(`${label}.stream must be an object.`);
  } else {
    const unknownStreamFields = Object.keys(stream).filter((key) => !["enabled", "completed", "completedBy"].includes(key));
    if (unknownStreamFields.length) errors.push(`${label}.stream contains unknown field(s): ${unknownStreamFields.sort().join(", ")}.`);
    if (typeof stream.enabled !== "boolean") errors.push(`${label}.stream.enabled must be boolean.`);
    if (typeof stream.completed !== "boolean") errors.push(`${label}.stream.completed must be boolean.`);
    const completedBy = stream.completedBy;
    if (
      completedBy !== undefined &&
      completedBy !== "done_sentinel" &&
      completedBy !== "provider_stop_event" &&
      completedBy !== "reader_done"
    ) {
      errors.push(`${label}.stream.completedBy is invalid.`);
    }
    if (outcome === "completed" && stream.completed !== true) errors.push(`${label}.stream.completed must be true for a completed call.`);
    if (outcome === "completed" && completedBy === undefined) errors.push(`${label}.stream.completedBy is required for a completed call.`);
    if ((outcome === "failed" || outcome === "aborted") && stream.completed !== false) {
      errors.push(`${label}.stream.completed must be false for a failed or aborted call.`);
    }
    if ((outcome === "failed" || outcome === "aborted") && completedBy !== undefined) {
      errors.push(`${label}.stream.completedBy must be absent for a failed or aborted call.`);
    }
  }
  errors.push(...validateReasonerCallFailure(input.failure, outcome, `${label}.failure`));
  return errors;
}

function validateReasonerCallUsage(input: unknown, label: string): string[] {
  if (input === undefined) return [];
  if (!isReasonerEvidenceRecord(input)) return [`${label} must be an object when recorded.`];
  const errors: string[] = [];
  const unknown = Object.keys(input).filter((key) => !["promptTokens", "completionTokens", "totalTokens"].includes(key));
  if (unknown.length) errors.push(`${label} contains unknown field(s): ${unknown.sort().join(", ")}.`);
  for (const field of ["promptTokens", "completionTokens", "totalTokens"] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
      errors.push(`${label}.${field} must be a nonnegative integer when recorded.`);
    }
  }
  return errors;
}

function validateReasonerRetryHistory(input: unknown, label: string): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return [`${label} must be an array when recorded.`];
  const errors: string[] = [];
  const allowed = new Set(["attempt", "failureKind", "providerStage", "status", "timeoutMs", "aborted", "retryable", "delayMs"]);
  for (const [index, entry] of input.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!isReasonerEvidenceRecord(entry)) {
      errors.push(`${itemLabel} must be an object.`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length) errors.push(`${itemLabel} contains unknown field(s): ${unknown.sort().join(", ")}.`);
    if (!Number.isInteger(entry.attempt) || Number(entry.attempt) <= 0) errors.push(`${itemLabel}.attempt must be a positive integer.`);
    if (typeof entry.retryable !== "boolean") errors.push(`${itemLabel}.retryable must be boolean.`);
    for (const field of ["status", "timeoutMs", "delayMs"] as const) {
      const value = entry[field];
      if (value !== undefined && (!Number.isFinite(value) || Number(value) < 0)) errors.push(`${itemLabel}.${field} must be nonnegative.`);
    }
    if (entry.aborted !== undefined && typeof entry.aborted !== "boolean") errors.push(`${itemLabel}.aborted must be boolean.`);
  }
  return errors;
}

function validateReasonerCallFailure(input: unknown, outcome: unknown, label: string): string[] {
  if (outcome === "completed") return input === undefined ? [] : [`${label} must be absent for a completed call.`];
  if (outcome !== "failed" && outcome !== "aborted") return [];
  if (!isReasonerEvidenceRecord(input)) return [`${label} is required for a failed or aborted call.`];
  const allowed = new Set(["failureKind", "providerStage", "status", "timeoutMs", "aborted", "retryable", "attempts", "maxAttempts"]);
  const errors: string[] = [];
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) errors.push(`${label} contains unknown field(s): ${unknown.sort().join(", ")}.`);
  const failureKinds = new Set(["http", "timeout", "abort", "stream_invalid_json", "stream_empty", "stream_incomplete", "stream_missing_body", "non_json", "empty_content", "network", "gateway_html", "unknown"]);
  if (typeof input.failureKind !== "string" || !failureKinds.has(input.failureKind)) errors.push(`${label}.failureKind is invalid.`);
  if (outcome === "aborted" && input.failureKind !== "abort" && input.failureKind !== "timeout" && input.aborted !== true) {
    errors.push(`${label} must identify an abort or timeout for an aborted call.`);
  }
  for (const field of ["status", "timeoutMs", "attempts", "maxAttempts"] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < (field === "attempts" || field === "maxAttempts" ? 1 : 0))) {
      errors.push(`${label}.${field} is invalid.`);
    }
  }
  if (input.aborted !== undefined && typeof input.aborted !== "boolean") errors.push(`${label}.aborted must be boolean.`);
  if (input.retryable !== undefined && typeof input.retryable !== "boolean") errors.push(`${label}.retryable must be boolean.`);
  return errors;
}

function isReasonerEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameCanonicalSocialExposureValue(left: unknown, right: unknown): boolean {
  try {
    return hashStableState(left) === hashStableState(right);
  } catch {
    return false;
  }
}

/**
 * A true parallel transition is one atomic environment step over a complete
 * joint command set. These structural checks prevent an artifact from being
 * replayed as a truncated or mixed batch.
 */
export function validateSocialParallelBatchLayout<TObservation, TPending, TCommand>(
  steps: ReadonlyArray<SocialHarnessStep<TObservation, TPending, TCommand>>
): string[] {
  const errors: string[] = [];
  const stepsByBatchId = new Map<string, Array<{ index: number; step: SocialHarnessStep<TObservation, TPending, TCommand> }>>();
  const parallelBatchIds = new Set<string>();

  for (const [index, step] of steps.entries()) {
    const batchId = step.batchId?.trim();
    if (batchId) {
      const entries = stepsByBatchId.get(batchId) ?? [];
      entries.push({ index, step });
      stepsByBatchId.set(batchId, entries);
    }

    if (step.schedulerMode !== "parallel") {
      if (step.resolutionPolicy === "parallel-stepBatch") {
        errors.push(`steps[${index}] uses parallel-stepBatch without the parallel scheduler.`);
      }
      continue;
    }
    if (isParallelSystemTransitionStep(step)) continue;

    if (step.atomic !== true) {
      errors.push(`steps[${index}] parallel step must be atomic.`);
    }
    if (step.resolutionPolicy !== "parallel-stepBatch") {
      errors.push(`steps[${index}] parallel step must use resolutionPolicy parallel-stepBatch.`);
    }
    if (!batchId) {
      errors.push(`steps[${index}] parallel batch is missing batchId.`);
    } else {
      parallelBatchIds.add(batchId);
    }
    if (!isPositiveInteger(step.batchIndex)) {
      errors.push(`steps[${index}] parallel batch has invalid batchIndex ${String(step.batchIndex)}.`);
    }
    if (!isPositiveInteger(step.batchSize)) {
      errors.push(`steps[${index}] parallel batch has invalid batchSize ${String(step.batchSize)}.`);
    }
  }

  for (const batchId of parallelBatchIds) {
    const batch = stepsByBatchId.get(batchId) ?? [];
    const reference = batch.find(({ step }) => step.schedulerMode === "parallel" && !isParallelSystemTransitionStep(step));
    if (!reference) continue;

    const { step: first } = reference;
    const expectedSize = first.batchSize;
    const expectedBatchIndex = first.batchIndex;
    for (let offset = 1; offset < batch.length; offset += 1) {
      if (batch[offset].index !== batch[offset - 1].index + 1) {
        errors.push(`parallel batch ${batchId} is not contiguous.`);
        break;
      }
    }
    if (isPositiveInteger(expectedSize) && batch.length !== expectedSize) {
      errors.push(`parallel batch ${batchId} is incomplete: expected ${expectedSize} steps, found ${batch.length}.`);
    }

    const actorIds = new Set<string>();
    const committed = isSocialStepCommitted(first);
    for (const { index, step } of batch) {
      if (!isSocialParallelJointStep(step)) {
        errors.push(`steps[${index}] joins parallel batch ${batchId} without parallel atomic metadata.`);
      }
      if (step.batchSize !== expectedSize) {
        errors.push(`steps[${index}] batchSize ${String(step.batchSize)} does not match parallel batch ${batchId} size ${String(expectedSize)}.`);
      }
      if (step.batchIndex !== expectedBatchIndex) {
        errors.push(`steps[${index}] batchIndex ${String(step.batchIndex)} does not match parallel batch ${batchId}.`);
      }
      if (step.preStateHash !== first.preStateHash) {
        errors.push(`steps[${index}] preStateHash does not match parallel batch ${batchId}.`);
      }
      if (step.decisionStateHash !== first.decisionStateHash) {
        errors.push(`steps[${index}] decisionStateHash does not match parallel batch ${batchId}.`);
      }
      if (isSocialStepCommitted(step) !== committed) {
        errors.push(`steps[${index}] commit status does not match parallel batch ${batchId}.`);
      }
      if (actorIds.has(step.actorId)) {
        errors.push(`steps[${index}] duplicates actor ${step.actorId} in parallel batch ${batchId}.`);
      }
      actorIds.add(step.actorId);
      if (committed && step.postStateHash !== first.postStateHash) {
        errors.push(`steps[${index}] postStateHash does not match committed parallel batch ${batchId}.`);
      }
      if (committed && !sameOptionalRange(step.eventSeqRange, first.eventSeqRange)) {
        errors.push(`steps[${index}] eventSeqRange does not match committed parallel batch ${batchId}.`);
      }
    }
  }
  return errors;
}

export function isSocialParallelJointStep(step: Pick<SocialHarnessStep, "schedulerMode" | "atomic" | "resolutionPolicy">): boolean {
  return step.schedulerMode === "parallel" && step.atomic === true && step.resolutionPolicy === "parallel-stepBatch";
}

function isParallelSystemTransitionStep(
  step: Pick<SocialHarnessStep, "actorId" | "schedulerMode" | "atomic" | "resolutionPolicy">
): boolean {
  return (
    step.schedulerMode === "parallel" &&
    step.actorId === "system" &&
    step.atomic !== true &&
    (step.resolutionPolicy === "system-transition" || step.resolutionPolicy === "scheduler-validation")
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sameOptionalRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}
