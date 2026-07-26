import { commandTypeFromUnknown, isForkParentTraceRef, isRecord, resolveAgentSnapshotsForValidation, sameRange, validateAgentSnapshotFrameReference, validateAgentSnapshotFrames, validateEventSeqRange, validateMatchArtifactRulesetBinding, validateMessageSeqRange, validateMutationRange, validateStepAgentSnapshots } from "./validationSupport";
import { GameCommand, GameState } from "../../core/types";
import { validateWerewolfAgentHarnessStateSnapshot } from "../actor";
import { validateHarnessEpisodeArtifactEnvelope } from "../episodeArtifacts";
import { hashStableState } from "../hash";
import { replayWerewolfSocialEpisode } from "../replay";
import { SocialEpisodeArtifact, isSocialStepCommitted } from "../social";
import { HarnessEvaluationReport } from "../types";
import { AgentSnapshotFrame, HARNESS_CHECKPOINT_VERSION, MATCH_ARTIFACT_VERSION, MatchArtifact } from "./types";
export function validateMatchArtifactIntegrity(artifact: MatchArtifact): string[] {
  const errors = validateHarnessEpisodeArtifactEnvelope(artifact);
  const snapshotFramesById = new Map((artifact.agentSnapshotFrames ?? []).map((frame) => [frame.frameId, frame]));
  if (artifact.artifactVersion !== MATCH_ARTIFACT_VERSION) errors.push(`artifactVersion must be ${MATCH_ARTIFACT_VERSION}.`);
  if (artifact.kind !== "match") errors.push("kind must be match.");
  if (artifact.forkOf) {
    if (artifact.forkOf.checkpointArtifactVersion !== HARNESS_CHECKPOINT_VERSION) {
      errors.push(`forkOf.checkpointArtifactVersion must be ${HARNESS_CHECKPOINT_VERSION}.`);
    }
  }
  const errorsBeforeRulesetBinding = errors.length;
  validateMatchArtifactRulesetBinding(artifact, errors);
  const rulesetBindingInvalid = errors.length > errorsBeforeRulesetBinding;

  const finalEvents = artifact.finalState.events ?? [];
  if (artifact.events.length !== finalEvents.length) {
    errors.push(`events length mismatch: expected ${finalEvents.length}, received ${artifact.events.length}.`);
  }
  const eventSeqs = new Set<number>();
  for (const [index, event] of artifact.events.entries()) {
    eventSeqs.add(event.seq);
    const finalEvent = finalEvents[index];
    if (!finalEvent) continue;
    if (event.seq !== finalEvent.seq || event.type !== finalEvent.type || event.id !== finalEvent.id) {
      errors.push(`events[${index}] does not match finalState.events[${index}].`);
    }
  }

  validateNativeSocialExecution(artifact, errors, { replay: !rulesetBindingInvalid });

  const socialStepByTrace = new Map(artifact.socialEpisode.steps.map((step) => [step.traceId, step]));
  const messageSeqs = new Set(artifact.socialEpisode.messages.map((message) => message.seq));
  const deliveryReceiptById = new Map(
    artifact.socialEpisode.messages.flatMap((message) =>
      (message.deliveryReceipts ?? []).map((receipt) => [receipt.id, { message, receipt }] as const)
    )
  );
  const playerIds = new Set(artifact.finalState.players.map((player) => player.id));
  validateAgentSnapshotFrames(artifact, playerIds, errors);
  const hasStepAgentSnapshots = artifact.trajectory.some(
    (step) =>
      step.agentSnapshotsAfterStep !== undefined ||
      step.agentSnapshotsHashAfterStep !== undefined ||
      step.agentSnapshotFrameIdAfterStep !== undefined
  ) || Boolean(artifact.agentSnapshotFrames?.length);
  for (const [index, step] of artifact.trajectory.entries()) {
    validateEventSeqRange(step.eventSeqRange, eventSeqs, `trajectory[${index}].eventSeqRange`, errors);
    validateMessageSeqRange(step.messageSeqRange, messageSeqs, `trajectory[${index}].messageSeqRange`, errors);
    validateAgentSnapshotFrameReference({
      framesById: snapshotFramesById,
      frameId: step.agentSnapshotFrameIdAfterStep,
      snapshotHash: step.agentSnapshotsHashAfterStep,
      label: `trajectory[${index}]`,
      fieldName: "agentSnapshotFrameIdAfterStep",
      hashFieldName: "agentSnapshotsHashAfterStep",
      errors
    });
    const snapshots = resolveAgentSnapshotsForValidation(step, snapshotFramesById);
    validateStepAgentSnapshots({
      snapshots,
      snapshotHash: step.agentSnapshotsHashAfterStep,
      playerIds,
      actorId: step.actorId,
      label: `trajectory[${index}]`,
      required: hasStepAgentSnapshots,
      snapshotPayloadAlreadyValidated: Boolean(step.agentSnapshotFrameIdAfterStep),
      errors
    });
    const socialStep = socialStepByTrace.get(step.traceId);
    if (!socialStep) {
      errors.push(`trajectory[${index}] traceId ${step.traceId} has no matching socialEpisode step.`);
      continue;
    }
    if (socialStep.actorId !== step.actorId) errors.push(`trajectory[${index}] actorId mismatch with socialEpisode step ${step.traceId}.`);
    if (socialStep.commitStatus && socialStep.commitStatus !== "committed") {
      errors.push(`trajectory[${index}] references non-committed socialEpisode step ${step.traceId}.`);
    }
    if (socialStep.preStateHash !== step.preStateHash) errors.push(`trajectory[${index}] preStateHash mismatch with socialEpisode step ${step.traceId}.`);
    if (socialStep.postStateHash !== step.postStateHash) errors.push(`trajectory[${index}] postStateHash mismatch with socialEpisode step ${step.traceId}.`);
    if (!sameRange(socialStep.eventSeqRange, step.eventSeqRange)) {
      errors.push(`trajectory[${index}] eventSeqRange mismatch with socialEpisode step ${step.traceId}.`);
    }
    if (!sameRange(socialStep.messageSeqRange, step.messageSeqRange)) {
      errors.push(`trajectory[${index}] messageSeqRange mismatch with socialEpisode step ${step.traceId}.`);
    }
    if ((socialStep.actorSnapshotsHashAfterStep ?? undefined) !== (step.agentSnapshotsHashAfterStep ?? undefined)) {
      errors.push(`trajectory[${index}] agentSnapshotsHashAfterStep mismatch with socialEpisode step ${step.traceId}.`);
    }
    if ((socialStep.actorSnapshotFrameIdAfterStep ?? undefined) !== (step.agentSnapshotFrameIdAfterStep ?? undefined)) {
      errors.push(`trajectory[${index}] agentSnapshotFrameIdAfterStep mismatch with socialEpisode step ${step.traceId}.`);
    }
    validateAgentSnapshotFrameReference({
      framesById: snapshotFramesById,
      frameId: socialStep.actorSnapshotFrameIdAfterStep,
      snapshotHash: socialStep.actorSnapshotsHashAfterStep,
      label: `socialEpisode step ${step.traceId}`,
      fieldName: "actorSnapshotFrameIdAfterStep",
      hashFieldName: "actorSnapshotsHashAfterStep",
      errors
    });
    const socialCommandType = commandTypeFromUnknown(socialStep.action.command);
    if (socialCommandType && socialCommandType !== step.command.type) {
      errors.push(`trajectory[${index}] command type mismatch with socialEpisode step ${step.traceId}: ${socialCommandType} !== ${step.command.type}.`);
    }
  }
  validateRecordedMemoryRetrieval(artifact, snapshotFramesById, errors);
  validateRecordedReceiptReflections(artifact, snapshotFramesById, errors);
  const lastSuccessfulStep = artifact.trajectory.at(-1);
  if (artifact.status !== "failed" && lastSuccessfulStep?.agentSnapshotsHashAfterStep) {
    const finalAgentsHash = hashStableState(artifact.agents);
    if (lastSuccessfulStep.agentSnapshotsHashAfterStep !== finalAgentsHash) {
      errors.push(`Last trajectory agentSnapshotsAfterStep does not match final artifact agents.`);
    }
  }

  const seenAgentIds = new Set<string>();
  const traceIds = new Set([
    ...artifact.trajectory.map((step) => step.traceId),
    ...artifact.socialEpisode.steps.map((step) => step.traceId)
  ]);
  for (const [index, agent] of artifact.agents.entries()) {
    if (seenAgentIds.has(agent.playerId)) errors.push(`agents[${index}] duplicates playerId ${agent.playerId}.`);
    seenAgentIds.add(agent.playerId);
    if (!playerIds.has(agent.playerId)) errors.push(`agents[${index}] references unknown player ${agent.playerId}.`);
    for (const error of validateWerewolfAgentHarnessStateSnapshot(agent, {
      requireSocialState: true,
      requireSocialStateHash: true
    })) {
      errors.push(`agents[${index}].${error}`);
    }

    for (const entry of agent.social?.journal?.entries ?? []) {
      if (entry.agentId !== agent.playerId) {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} agentId mismatch: ${entry.agentId} !== ${agent.playerId}.`);
      }
      const evidenceRefs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [];
      if (!Array.isArray(entry.evidenceRefs)) {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidenceRefs must be an array.`);
      }
      if (!evidenceRefs.length) errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} is missing evidenceRefs.`);
      if (entry.redactionClass !== "agent_private_summary") {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} has invalid redactionClass ${entry.redactionClass}.`);
      }
      if (entry.hiddenTruthUsed) errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} uses hidden truth.`);
      validateMutationRange(entry.messageSeqRange, messageSeqs, `agents[${index}].social.journal entry ${entry.journalSeq}.messageSeqRange`, errors);
      validateMutationRange(entry.eventSeqRange, eventSeqs, `agents[${index}].social.journal entry ${entry.journalSeq}.eventSeqRange`, errors);
      for (const evidenceRef of evidenceRefs) {
        if (evidenceRef.artifact === "message" && evidenceRef.seq !== undefined && !messageSeqs.has(evidenceRef.seq)) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing message seq ${evidenceRef.seq}.`);
        }
        if (evidenceRef.artifact === "event" && evidenceRef.seq !== undefined && !eventSeqs.has(evidenceRef.seq)) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing event seq ${evidenceRef.seq}.`);
        }
        if (evidenceRef.artifact === "delivery_receipt") {
          const binding = evidenceRef.id ? deliveryReceiptById.get(evidenceRef.id) : undefined;
          if (!binding) {
            errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing delivery receipt ${evidenceRef.id ?? "unknown"}.`);
          } else {
            if (binding.receipt.observerId !== agent.playerId) {
              errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} delivery receipt observer mismatch.`);
            }
            if (evidenceRef.seq !== binding.message.seq) {
              errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} delivery receipt message seq mismatch.`);
            }
            if (!evidenceRefs.some((ref) =>
              ref.artifact === "message" && ref.id === binding.message.id && ref.seq === binding.message.seq
            )) {
              errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} delivery receipt lacks matching message evidence.`);
            }
          }
        }
        if (
          evidenceRef.artifact === "trace" &&
          evidenceRef.traceId &&
          !traceIds.has(evidenceRef.traceId) &&
          !isForkParentTraceRef(artifact, evidenceRef.traceId)
        ) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing trace ${evidenceRef.traceId}.`);
        }
      }
    }
    for (const attribution of Object.values(agent.social?.theoryOfMind?.records ?? {})) {
      if (!attribution.sourceDeliveryReceiptId) continue;
      const binding = deliveryReceiptById.get(attribution.sourceDeliveryReceiptId);
      if (
        !binding ||
        binding.receipt.observerId !== agent.playerId ||
        binding.receipt.observerId !== attribution.observerId ||
        binding.message.id !== attribution.sourceMessageId ||
        binding.message.seq !== attribution.sourceMessageSeq ||
        binding.message.senderId !== attribution.subjectId
      ) {
        errors.push(`agents[${index}].social.theoryOfMind ${attribution.id} has invalid delivery receipt binding.`);
      }
    }
  }
  for (const playerId of playerIds) {
    if (!seenAgentIds.has(playerId)) errors.push(`Missing agent state for player ${playerId}.`);
  }

  if (artifact.evaluationReport.metricCount !== artifact.evaluationReport.metrics.length) {
    errors.push(
      `evaluationReport.metricCount mismatch: expected ${artifact.evaluationReport.metrics.length}, received ${artifact.evaluationReport.metricCount}.`
    );
  }
  validateEvaluationFailureIntegrity(artifact.evaluationReport, errors);
  validateEvaluationPromotionIntegrity(artifact.evaluationReport, errors);

  return errors;
}

function validateEvaluationFailureIntegrity(report: HarnessEvaluationReport, errors: string[]): void {
  const status = report.status ?? "completed";
  const failures = report.failures ?? [];
  if (status !== "completed" && status !== "incomplete") {
    errors.push(`evaluationReport.status must be completed or incomplete.`);
  }
  if (!Array.isArray(failures)) {
    errors.push("evaluationReport.failures must be an array when present.");
    return;
  }
  if ((status === "completed") !== (failures.length === 0)) {
    errors.push("evaluationReport.status must be completed exactly when failures is empty.");
  }
  for (const [index, failure] of failures.entries()) {
    const label = `evaluationReport.failures[${index}]`;
    if (!isRecord(failure)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    for (const key of Object.keys(failure)) {
      if (!["evaluatorId", "label", "version", "stage", "code", "message"].includes(key)) {
        errors.push(`${label}.${key} is not permitted.`);
      }
    }
    if (typeof failure.evaluatorId !== "string" || !failure.evaluatorId) errors.push(`${label}.evaluatorId must be a non-empty string.`);
    if (typeof failure.label !== "string" || !failure.label) errors.push(`${label}.label must be a non-empty string.`);
    if (typeof failure.version !== "string" || !failure.version) errors.push(`${label}.version must be a non-empty string.`);
    if (failure.stage !== "evaluate" && failure.stage !== "result_normalization") {
      errors.push(`${label}.stage must be evaluate or result_normalization.`);
    }
    const expectedCode = failure.stage === "evaluate" ? "evaluator_exception" : "invalid_module_result";
    const expectedMessage =
      failure.stage === "evaluate"
        ? "Evaluator execution failed; no metrics or output were recorded."
        : "Evaluator returned an invalid module result; no metrics or output were recorded.";
    if (failure.code !== expectedCode) errors.push(`${label}.code does not match its stage.`);
    if (failure.message !== expectedMessage) errors.push(`${label}.message must use the controlled message for its stage.`);
  }
}

/**
 * Recall is decision evidence, never replay input. Validate its immutable
 * metadata binding without reconstructing an actor, rerunning selection, or
 * exposing memory content from a private snapshot.
 */
function validateRecordedMemoryRetrieval(
  artifact: MatchArtifact,
  snapshotFramesById: ReadonlyMap<string, AgentSnapshotFrame>,
  errors: string[]
): void {
  const socialStepByTrace = new Map(artifact.socialEpisode.steps.map((step) => [step.traceId, step]));
  for (const [index, step] of artifact.trajectory.entries()) {
    const retrieval = step.policyPlan.memoryRetrieval;
    const traceRetrieval = step.turnTrace.memoryRetrieval;
    if (retrieval === undefined && traceRetrieval === undefined) continue;
    const label = `trajectory[${index}].memoryRetrieval`;
    validateMemoryRetrievalRecord(retrieval, label, step.actorId, step.traceId, errors);
    if (hashStableState(retrieval) !== hashStableState(traceRetrieval)) {
      errors.push(`${label} does not match turnTrace.memoryRetrieval.`);
    }

    const socialStep = socialStepByTrace.get(step.traceId);
    const metadata = socialStep?.action.metadata as Record<string, unknown> | undefined;
    const metadataPlan = metadata?.policyPlan as Record<string, unknown> | undefined;
    const metadataTrace = metadata?.turnTrace as Record<string, unknown> | undefined;
    if (hashStableState(metadataPlan?.memoryRetrieval) !== hashStableState(retrieval)) {
      errors.push(`${label} does not match socialEpisode action policyPlan evidence.`);
    }
    if (hashStableState(metadataTrace?.memoryRetrieval) !== hashStableState(traceRetrieval)) {
      errors.push(`${label} does not match socialEpisode action turnTrace evidence.`);
    }

    const snapshots = resolveAgentSnapshotsForValidation(step, snapshotFramesById);
    const actor = snapshots?.find((candidate) => candidate.playerId === step.actorId);
    if (!actor) continue;
    const decision = actor.social?.memory.entries.find(
      (entry) =>
        entry.kind === "decision" &&
        entry.evidenceRefs.some((ref) => ref.artifact === "trace" && ref.traceId === step.traceId)
    );
    if (!decision) {
      errors.push(`${label} is missing the committed decision-memory evidence in its actor snapshot.`);
      continue;
    }
    const decisionMetadata = decision.metadata as Record<string, unknown> | undefined;
    if (hashStableState(decisionMetadata?.memoryRetrieval) !== hashStableState(retrieval)) {
      errors.push(`${label} does not match its committed decision-memory evidence.`);
    }
  }
}

/**
 * Reflection prose is never re-evaluated. This validates only the immutable
 * typed record, its committed receipt ownership, content-free recall evidence,
 * and the memory/journal binding present at each recorded snapshot boundary.
 */
function validateRecordedReceiptReflections(
  artifact: MatchArtifact,
  snapshotFramesById: ReadonlyMap<string, AgentSnapshotFrame>,
  errors: string[]
): void {
  const nativeStepByTrace = new Map(artifact.socialEpisode.steps.map((step) => [step.traceId, step]));
  const lastTrajectoryIndexBySnapshot = new Map<string, number>();
  const seenReflectionHashes = new Map<string, string>();
  for (const [index, step] of artifact.trajectory.entries()) {
    const key = step.agentSnapshotsHashAfterStep ?? step.agentSnapshotFrameIdAfterStep;
    if (key) lastTrajectoryIndexBySnapshot.set(key, index);
  }
  for (const [index, step] of artifact.trajectory.entries()) {
    const key = step.agentSnapshotsHashAfterStep ?? step.agentSnapshotFrameIdAfterStep;
    if (!key || lastTrajectoryIndexBySnapshot.get(key) !== index) continue;
    const snapshots = resolveAgentSnapshotsForValidation(step, snapshotFramesById);
    if (!snapshots) continue;
    let boundaryStart = index;
    while (boundaryStart > 0) {
      const previous = artifact.trajectory[boundaryStart - 1]!;
      const previousKey = previous.agentSnapshotsHashAfterStep ?? previous.agentSnapshotFrameIdAfterStep;
      if (previousKey !== key) break;
      boundaryStart -= 1;
    }
    const boundaryTraces = new Set(artifact.trajectory.slice(boundaryStart, index + 1).map((candidate) => candidate.traceId));
    for (const [agentIndex, agent] of snapshots.entries()) {
      const memory = agent.social?.memory.entries ?? [];
      for (const [memoryIndex, entry] of memory.entries()) {
        if (entry.kind !== "reflection" && entry.reflection === undefined) continue;
        const label = `trajectory[${index}].agents[${agentIndex}].social.memory.entries[${memoryIndex}].reflection`;
        const record = isRecord(entry.reflection) ? entry.reflection : undefined;
        if (!record) {
          errors.push(`${label} must be a typed ReflectionRecord.`);
          continue;
        }
        if (typeof record.id === "string" && record.id) {
          const recordHash = hashStableState(entry);
          const priorHash = seenReflectionHashes.get(record.id);
          if (priorHash !== undefined) {
            if (priorHash !== recordHash) errors.push(`${label} changed after its first recorded receipt boundary.`);
            continue;
          }
          seenReflectionHashes.set(record.id, recordHash);
        }
        for (const field of Object.keys(record)) {
          if (!["version", "id", "agentId", "createdAtTurn", "kind", "content", "evidenceRefs", "confidence", "visibility", "source"].includes(field)) {
            errors.push(`${label}.${field} is not permitted in a ReflectionRecord.`);
          }
        }
        if (record.version !== "harness.reflection.v1") errors.push(`${label}.version must be harness.reflection.v1.`);
        if (record.agentId !== agent.playerId) errors.push(`${label}.agentId must match ${agent.playerId}.`);
        if (typeof record.id !== "string" || !record.id) errors.push(`${label}.id must be non-empty.`);
        if (!["memory_summary", "belief_revision", "strategy_update", "social_risk", "goal_revision"].includes(String(record.kind))) {
          errors.push(`${label}.kind is invalid.`);
        }
        if (typeof record.content !== "string" || !record.content.trim()) errors.push(`${label}.content must be non-empty.`);
        if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
          errors.push(`${label}.confidence must be finite and within [0, 1].`);
        }
        if (!["private", "team", "postgame"].includes(String(record.visibility))) errors.push(`${label}.visibility is invalid.`);
        if (!["policy", "reasoner", "evaluator", "human"].includes(String(record.source))) errors.push(`${label}.source is invalid.`);
        if (entry.content !== record.content) errors.push(`${label} content does not match its memory entry.`);
        if (entry.visibility !== record.visibility) errors.push(`${label} visibility does not match its memory entry.`);
        if (entry.source !== record.source) errors.push(`${label} source does not match its memory entry.`);
        if (hashStableState(entry.evidenceRefs) !== hashStableState(record.evidenceRefs)) {
          errors.push(`${label} evidenceRefs do not match its memory entry.`);
        }
        const refs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter(isRecord) : [];
        const outcomeRefs = refs.filter((ref) => ref.artifact === "outcome");
        if (outcomeRefs.length !== 1) errors.push(`${label} must have exactly one committed outcome reference.`);
        const outcomeRef = outcomeRefs[0];
        const traceId = typeof outcomeRef?.traceId === "string" ? outcomeRef.traceId : undefined;
        const nativeStep = traceId ? nativeStepByTrace.get(traceId) : undefined;
        const inheritedParentTrace = Boolean(traceId && isForkParentTraceRef(artifact, traceId));
        if (!traceId || (!boundaryTraces.has(traceId) && !inheritedParentTrace)) {
          errors.push(`${label} references a future or unknown receipt trace.`);
        }
        if ((!nativeStep || nativeStep.commitStatus !== "committed") && !inheritedParentTrace) {
          errors.push(`${label} must reference a committed native step.`);
        }
        if (nativeStep && nativeStep.actorId !== agent.playerId) errors.push(`${label} receipt actor does not match ${agent.playerId}.`);
        if (nativeStep && record.createdAtTurn !== nativeStep.turnIndex) errors.push(`${label}.createdAtTurn must match the receipt turnIndex.`);
        if (traceId) {
          if (record.id !== `${agent.playerId}:reflection:${traceId}`) errors.push(`${label}.id does not match its receipt trace.`);
          if (outcomeRef?.id !== `${traceId}:committed`) errors.push(`${label} outcome id does not match its committed receipt.`);
        }
        const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
        if (!metadata) {
          errors.push(`${label} memory metadata must be present.`);
        } else {
          for (const field of Object.keys(metadata)) {
            if (!["version", "policyId", "receiptId", "traceId", "memoryRetrieval"].includes(field)) {
              errors.push(`${label} memory metadata.${field} is not permitted.`);
            }
          }
          if (metadata.version !== "harness.receipt-reflection.v1") errors.push(`${label} memory metadata.version is invalid.`);
          if (typeof metadata.policyId !== "string" || !metadata.policyId) errors.push(`${label} memory metadata.policyId must be non-empty.`);
          if (traceId && (metadata.receiptId !== `${traceId}:committed` || metadata.traceId !== traceId)) {
            errors.push(`${label} memory metadata does not match its committed receipt.`);
          }
          if (traceId) validateMemoryRetrievalRecord(metadata.memoryRetrieval, `${label}.memoryRetrieval`, agent.playerId, traceId, errors);
        }
        if (traceId) {
          const outcome = memory.find((candidate) => candidate.kind === "outcome" && candidate.evidenceRefs.some(
            (ref) => ref.artifact === "outcome" && ref.traceId === traceId && ref.id === `${traceId}:committed`
          ));
          if (!outcome || outcome.seq >= entry.seq) errors.push(`${label} must follow its committed outcome memory.`);
          const journal = agent.social?.journal?.entries.find((candidate) =>
            candidate.mutationKind === "memory.appended" &&
            candidate.traceId === traceId &&
            isRecord(candidate.deltaSummary) &&
            candidate.deltaSummary.appendedSeq === entry.seq
          );
          if (!journal) errors.push(`${label} is missing its receipt-bound memory journal mutation.`);
        }
      }
    }
  }
}

function validateMemoryRetrievalRecord(
  value: unknown,
  label: string,
  actorId: string,
  traceId: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${label} must be a memory retrieval record.`);
    return;
  }
  if (value.version !== "harness.memory-retrieval.v1") errors.push(`${label}.version must be harness.memory-retrieval.v1.`);
  if (value.actorId !== actorId) errors.push(`${label}.actorId must match ${actorId}.`);
  if (value.traceId !== undefined && value.traceId !== traceId) errors.push(`${label}.traceId must match ${traceId}.`);
  const query = isRecord(value.query) ? value.query : undefined;
  if (!query) {
    errors.push(`${label}.query must be an object.`);
  } else {
    for (const key of Object.keys(query)) {
      if (!["limit", "tags", "visibility", "source", "ranking"].includes(key)) {
        errors.push(`${label}.query.${key} is not permitted in recorded retrieval evidence.`);
      }
    }
    if (!Number.isInteger(query.limit) || (query.limit as number) < 0) errors.push(`${label}.query.limit must be a non-negative integer.`);
    if (query.ranking !== "importance_then_salience_then_recency") {
      errors.push(`${label}.query.ranking must be importance_then_salience_then_recency.`);
    }
    if (query.tags !== undefined && (!Array.isArray(query.tags) || query.tags.some((tag) => typeof tag !== "string"))) {
      errors.push(`${label}.query.tags must be a string array when present.`);
    }
    if (query.visibility !== undefined && typeof query.visibility !== "string") errors.push(`${label}.query.visibility must be a string when present.`);
    if (query.source !== undefined && typeof query.source !== "string") errors.push(`${label}.query.source must be a string when present.`);
  }
  if (!Array.isArray(value.selected)) {
    errors.push(`${label}.selected must be an array.`);
    return;
  }
  const selectedSeqs = new Set<number>();
  for (const [selectedIndex, selection] of value.selected.entries()) {
    const itemLabel = `${label}.selected[${selectedIndex}]`;
    if (!isRecord(selection)) {
      errors.push(`${itemLabel} must be an object.`);
      continue;
    }
    for (const key of Object.keys(selection)) {
      if (!["memorySeq", "rank", "score", "scoreReasons", "kind", "source", "visibility", "tags", "evidenceRefs"].includes(key)) {
        errors.push(`${itemLabel}.${key} is not permitted in recorded retrieval evidence.`);
      }
    }
    if (!Number.isInteger(selection.memorySeq) || (selection.memorySeq as number) <= 0 || selectedSeqs.has(selection.memorySeq as number)) {
      errors.push(`${itemLabel}.memorySeq must be a unique positive integer.`);
    }
    selectedSeqs.add(selection.memorySeq as number);
    if (selection.rank !== selectedIndex + 1) errors.push(`${itemLabel}.rank must equal ${selectedIndex + 1}.`);
    if (typeof selection.score !== "number" || !Number.isFinite(selection.score)) errors.push(`${itemLabel}.score must be finite.`);
    if (
      !Array.isArray(selection.scoreReasons) ||
      selection.scoreReasons.join(",") !== "importance,salience,recency_tiebreak"
    ) {
      errors.push(`${itemLabel}.scoreReasons must record the stable ranking inputs.`);
    }
    if (typeof selection.kind !== "string" || !selection.kind) errors.push(`${itemLabel}.kind must be a non-empty string.`);
    if (typeof selection.source !== "string" || !selection.source) errors.push(`${itemLabel}.source must be a non-empty string.`);
    if (typeof selection.visibility !== "string" || !selection.visibility) errors.push(`${itemLabel}.visibility must be a non-empty string.`);
    if (!Array.isArray(selection.tags) || selection.tags.some((tag) => typeof tag !== "string")) errors.push(`${itemLabel}.tags must be a string array.`);
    if (!Array.isArray(selection.evidenceRefs) || !selection.evidenceRefs.length) errors.push(`${itemLabel}.evidenceRefs must be a non-empty array.`);
    for (const forbidden of ["content", "observation", "action", "metadata"]) {
      if (forbidden in selection) errors.push(`${itemLabel} must not persist raw memory ${forbidden}.`);
    }
  }
}

function validateEvaluationPromotionIntegrity(report: HarnessEvaluationReport, errors: string[]): void {
  const promotion = report.summary?.promotion;
  const recordedDecisionCount = report.metrics.filter((metric) => Boolean(metric.promotionDecision)).length;
  const usesRecordedDecisionContract = promotion?.decisionStorage === "per_metric_recorded";
  if (!usesRecordedDecisionContract && !recordedDecisionCount) return;
  const identityFields = [
    "policyId",
    "policyVersion",
    "policyHash",
    "catalogId",
    "catalogVersion",
    "catalogHash",
    "catalogDomainId"
  ] as const;

  for (const field of identityFields) {
    if (typeof promotion?.[field] !== "string" || !promotion[field]) {
      errors.push(`evaluationReport.summary.promotion.${field} is required for recorded metric decisions.`);
    }
  }

  for (const [index, metric] of report.metrics.entries()) {
    const decision = metric.promotionDecision;
    if (!decision) {
      errors.push(`evaluationReport.metrics[${index}] is missing promotionDecision for recorded catalog ${promotion?.catalogId ?? "unknown"}.`);
      continue;
    }

    if (decision.resolution !== "recorded") {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.resolution must be recorded.`);
    }
    if (
      decision.promotionClass !== "scorecard" &&
      decision.promotionClass !== "diagnostic" &&
      decision.promotionClass !== "benchmark_only"
    ) {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision has invalid promotionClass ${String(decision.promotionClass)}.`);
    }
    if (typeof decision.eligibleForScorecard !== "boolean") {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.eligibleForScorecard must be boolean.`);
    }
    if (
      !Array.isArray(decision.reasons) ||
      !decision.reasons.length ||
      decision.reasons.some((reason) => typeof reason !== "string" || !reason)
    ) {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.reasons must be a nonempty string array.`);
    }
    if (metric.promotionClass !== decision.promotionClass) {
      errors.push(
        `evaluationReport.metrics[${index}].promotionClass must match promotionDecision.promotionClass: ${String(metric.promotionClass)} !== ${decision.promotionClass}.`
      );
    }
    if (decision.eligibleForScorecard) {
      if (decision.promotionClass !== "scorecard") {
        errors.push(`evaluationReport.metrics[${index}].promotionDecision can only be scorecard-eligible with scorecard class.`);
      }
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires a finite numeric value.`);
      }
      if (typeof metric.weight !== "number" || !Number.isFinite(metric.weight) || metric.weight <= 0) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires a positive finite weight.`);
      }
      if (!(metric.evidenceRefs?.length ?? 0)) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires evidenceRefs.`);
      }
    }

    for (const field of identityFields) {
      const expected = promotion?.[field];
      if (typeof expected !== "string" || !expected) {
        errors.push(`evaluationReport.summary.promotion.${field} is required to validate recorded metric decision ${index}.`);
        continue;
      }
      if (decision[field] !== expected) {
        errors.push(
          `evaluationReport.metrics[${index}].promotionDecision.${field} mismatch: expected ${expected}, received ${String(decision[field])}.`
        );
      }
    }
  }

  if (!promotion) return;
  const decisions = report.metrics.flatMap((metric) => (metric.promotionDecision ? [{ metric, decision: metric.promotionDecision }] : []));
  const scorecardMetricCount = decisions.filter(({ decision }) => decision.eligibleForScorecard).length;
  const diagnosticMetricCount = decisions.filter(({ decision }) => !decision.eligibleForScorecard).length;
  const weightedMetrics = report.metrics.filter(
    (metric) => typeof metric.weight === "number" && Number.isFinite(metric.weight) && metric.weight > 0
  );
  const excludedWeighted = decisions.filter(
    ({ metric, decision }) =>
      typeof metric.weight === "number" && Number.isFinite(metric.weight) && metric.weight > 0 && !decision.eligibleForScorecard
  );
  const excludedWeightedMetricIds = [...new Set(excludedWeighted.map(({ metric }) => metric.id))].sort();
  if (promotion.scorecardMetricCount !== scorecardMetricCount) {
    errors.push(
      `evaluationReport.summary.promotion.scorecardMetricCount mismatch: expected ${scorecardMetricCount}, received ${promotion.scorecardMetricCount}.`
    );
  }
  if (promotion.diagnosticMetricCount !== diagnosticMetricCount) {
    errors.push(
      `evaluationReport.summary.promotion.diagnosticMetricCount mismatch: expected ${diagnosticMetricCount}, received ${promotion.diagnosticMetricCount}.`
    );
  }
  if (promotion.weightedMetricCount !== weightedMetrics.length) {
    errors.push(
      `evaluationReport.summary.promotion.weightedMetricCount mismatch: expected ${weightedMetrics.length}, received ${promotion.weightedMetricCount}.`
    );
  }
  if (promotion.excludedWeightedMetricCount !== excludedWeighted.length) {
    errors.push(
      `evaluationReport.summary.promotion.excludedWeightedMetricCount mismatch: expected ${excludedWeighted.length}, received ${promotion.excludedWeightedMetricCount}.`
    );
  }
  if (
    promotion.excludedWeightedMetricIds.length !== excludedWeightedMetricIds.length ||
    promotion.excludedWeightedMetricIds.some((metricId, index) => metricId !== excludedWeightedMetricIds[index])
  ) {
    errors.push("evaluationReport.summary.promotion.excludedWeightedMetricIds must match the sorted unique excluded weighted metric ids.");
  }
}

function validateNativeSocialExecution(artifact: MatchArtifact, errors: string[], options: { replay?: boolean } = {}): void {
  const execution = artifact.socialEpisode;
  const snapshotFramesById = new Map((artifact.agentSnapshotFrames ?? []).map((frame) => [frame.frameId, frame]));
  if (!execution.execution) {
    errors.push("socialEpisode.execution metadata is required for harness.match.v2.");
  } else {
    if (execution.execution.schemaVersion !== "harness.social-execution.v1") {
      errors.push(`socialEpisode.execution.schemaVersion must be harness.social-execution.v1.`);
    }
    if (
      execution.execution.decisionTimeoutMs !== undefined &&
      (!Number.isInteger(execution.execution.decisionTimeoutMs) || execution.execution.decisionTimeoutMs <= 0)
    ) {
      errors.push("socialEpisode.execution.decisionTimeoutMs must be a positive integer when recorded.");
    }
    const initialMessageCount = execution.execution.initialMessageCount;
    if (!Number.isInteger(initialMessageCount) || initialMessageCount < 0 || initialMessageCount > execution.messages.length) {
      errors.push(`socialEpisode.execution.initialMessageCount is invalid: ${initialMessageCount}.`);
    } else {
      const initialMessages = execution.messages.slice(0, initialMessageCount);
      const expectedInitialMessagesHash = hashStableState(initialMessages);
      if (!execution.execution.initialMessagesHash) {
        errors.push("socialEpisode.execution.initialMessagesHash is required.");
      } else if (execution.execution.initialMessagesHash !== expectedInitialMessagesHash) {
        errors.push(
          `socialEpisode.execution.initialMessagesHash mismatch: expected ${expectedInitialMessagesHash}, received ${execution.execution.initialMessagesHash}.`
        );
      }
      if (artifact.forkOf?.parentMessagesHash && execution.execution.initialMessagesHash !== artifact.forkOf.parentMessagesHash) {
        errors.push("socialEpisode initial message prefix does not match forkOf.parentMessagesHash.");
      }
      if (artifact.forkOf && initialMessageCount !== artifact.forkOf.parentMessageCount) {
        errors.push("socialEpisode initial message count does not match forkOf.parentMessageCount.");
      }
    }
  }

  if (artifact.forkOf?.parentChannelsHash && hashStableState(execution.channels) !== artifact.forkOf.parentChannelsHash) {
    errors.push("socialEpisode channels do not match forkOf.parentChannelsHash.");
  }
  if (artifact.forkOf?.parentStateHash && hashStableState(execution.initialState) !== artifact.forkOf.parentStateHash) {
    errors.push("socialEpisode initial state does not match forkOf.parentStateHash.");
  }

  if (hashStableState(execution.initialState) !== hashStableState(artifact.initialState)) {
    errors.push("socialEpisode.initialState does not match artifact.initialState.");
  }
  if (hashStableState(execution.finalState) !== hashStableState(artifact.finalState)) {
    errors.push("socialEpisode.finalState does not match artifact.finalState.");
  }

  for (const [index, step] of execution.steps.entries()) {
    const committed = isSocialStepCommitted(step);
    if (committed && (!step.preStateHash || !step.postStateHash)) {
      errors.push(`socialEpisode.steps[${index}] committed step requires preStateHash and postStateHash.`);
    }
    if (!committed && step.messageSeqRange) {
      errors.push(`socialEpisode.steps[${index}] rejected step cannot reference committed messages.`);
    }
    validateAgentSnapshotFrameReference({
      framesById: snapshotFramesById,
      frameId: step.actorSnapshotFrameIdAfterStep,
      snapshotHash: step.actorSnapshotsHashAfterStep,
      label: `socialEpisode.steps[${index}]`,
      fieldName: "actorSnapshotFrameIdAfterStep",
      hashFieldName: "actorSnapshotsHashAfterStep",
      errors
    });
  }

  if (options.replay !== false) {
    const replay = replayWerewolfSocialEpisode(execution as SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>, {
      stopOnMismatch: false,
      agentSnapshotFrames: artifact.agentSnapshotFrames,
      // The generic artifact-envelope validation above already audits the
      // canonical actor-state frame registry. Repeating that full payload
      // audit inside deterministic environment replay multiplied startup
      // memory for large completed matches without adding an independent
      // integrity boundary.
      auditAgentSnapshots: false
    });
    for (const mismatch of replay.mismatches) errors.push(`socialEpisode replay: ${mismatch}`);
  }
}

export function assertValidMatchArtifactIntegrity(artifact: MatchArtifact): void {
  const errors = validateMatchArtifactIntegrity(artifact);
  if (errors.length) throw new Error(`Invalid match artifact ${artifact.runId}: ${errors.join(" ")}`);
}
