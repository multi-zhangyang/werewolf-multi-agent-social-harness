import { isSupportedWerewolfRulesetId } from "../../core/roles";
import { GameConfig, GameState } from "../../core/types";
import { validateWerewolfAgentHarnessStateSnapshot } from "../actor";
import { harnessAgentSnapshotFrameId } from "../episodeArtifacts";
import { hashStableState } from "../hash";
import { SocialEpisodeArtifact } from "../social";
import { AgentHarnessState, HarnessStepRecord } from "../types";
import { AGENT_SNAPSHOT_FRAME_VERSION, AgentSnapshotFrame, HarnessCheckpoint, HarnessCheckpointPrefixSelector, HarnessCheckpointSelectionError, MatchArtifact } from "./types";
/**
 * The harness envelope remains domain-neutral; this validator is deliberately
 * kept in the Werewolf artifact specialization.  A single replay recipe must
 * not combine config/state/episode/fork records from different semantics.
 */
export function validateMatchArtifactRulesetBinding(artifact: MatchArtifact, errors: string[]): void {
  validateWerewolfRulesetId(artifact.rulesetId, "rulesetId", errors);
  const configs: Array<[string, GameConfig | undefined]> = [
    ["config", artifact.config],
    ["initialState.config", artifact.initialState?.config],
    ["finalState.config", artifact.finalState?.config],
    ["socialEpisode.initialState.config", (artifact.socialEpisode?.initialState as GameState | undefined)?.config],
    ["socialEpisode.finalState.config", (artifact.socialEpisode?.finalState as GameState | undefined)?.config]
  ];
  for (const [label, config] of configs) {
    validateWerewolfRulesetId(config?.rulesetId, `${label}.rulesetId`, errors);
    if (config?.rulesetId !== artifact.rulesetId) {
      errors.push(`${label}.rulesetId does not match artifact.rulesetId.`);
    }
  }

  const canonicalConfig = artifact.config;
  const canonicalConfigHash = hashStableState(canonicalConfig);
  for (const [label, config] of configs.slice(1)) {
    if (hashStableState(config) !== canonicalConfigHash) {
      errors.push(`${label} does not match artifact.config.`);
    }
  }

  if (artifact.forkOf) {
    validateWerewolfRulesetId(artifact.forkOf.parentRulesetId, "forkOf.parentRulesetId", errors);
    if (artifact.forkOf.parentRulesetId !== artifact.config?.rulesetId) {
      errors.push("forkOf.parentRulesetId does not match artifact.config.rulesetId.");
    }
  }
}

export function validateHarnessCheckpointRulesetBinding(checkpoint: HarnessCheckpoint, errors: string[]): void {
  validateWerewolfRulesetId(checkpoint.source.rulesetId, "source.rulesetId", errors);
  const configs: Array<[string, GameConfig | undefined]> = [
    ["state.config", checkpoint.state?.config],
    ["executionPrefix.initialState.config", (checkpoint.executionPrefix?.initialState as GameState | undefined)?.config],
    ["executionPrefix.finalState.config", (checkpoint.executionPrefix?.finalState as GameState | undefined)?.config]
  ];
  for (const [label, config] of configs) {
    validateWerewolfRulesetId(config?.rulesetId, `${label}.rulesetId`, errors);
    if (config?.rulesetId !== checkpoint.source.rulesetId) {
      errors.push(`${label}.rulesetId does not match source.rulesetId.`);
    }
  }

  const stateConfigHash = hashStableState(checkpoint.state?.config);
  for (const [label, config] of configs.slice(1)) {
    if (hashStableState(config) !== stateConfigHash) {
      errors.push(`${label} does not match state.config.`);
    }
  }
}

function validateWerewolfRulesetId(value: unknown, label: string, errors: string[]): void {
  if (!isSupportedWerewolfRulesetId(value)) {
    errors.push(`${label} must be a supported Werewolf ruleset id; received ${typeof value === "string" && value ? value : "<missing>"}.`);
  }
}

export function resolveAgentSnapshotsAfterNativeStep(
  artifact: MatchArtifact,
  step: MatchArtifact["socialEpisode"]["steps"][number]
): AgentHarnessState[] | undefined {
  if (Array.isArray(step.actorSnapshotsAfterStep)) return cloneJson(step.actorSnapshotsAfterStep) as AgentHarnessState[];
  if (!step.actorSnapshotFrameIdAfterStep) return undefined;
  const frame = artifact.agentSnapshotFrames?.find((candidate) => candidate.frameId === step.actorSnapshotFrameIdAfterStep);
  if (!frame || frame.agentsHash !== step.actorSnapshotsHashAfterStep) return undefined;
  return cloneJson(frame.agents);
}

export function resolveCheckpointPrefixSelection(
  artifact: MatchArtifact,
  selector: HarnessCheckpointPrefixSelector
): { index: number; step: SocialEpisodeArtifact["steps"][number] } {
  const selectors = [
    selector.traceId !== undefined ? "traceId" : undefined,
    selector.nativeTurnIndex !== undefined ? "nativeTurnIndex" : undefined,
    selector.nativeStepCount !== undefined ? "nativeStepCount" : undefined
  ].filter((value): value is string => Boolean(value));
  if (selectors.length !== 1) {
    throw new HarnessCheckpointSelectionError(
      selectors.length === 0 ? "selector_not_found" : "ambiguous_selector",
      selectors.length === 0
        ? "Prefix checkpoint requires exactly one selector."
        : `Prefix checkpoint selector is ambiguous: ${selectors.join(", ")}.`
    );
  }
  let index = -1;
  if (selector.traceId !== undefined) {
    index = artifact.socialEpisode.steps.findIndex((step) => step.traceId === selector.traceId);
  } else if (selector.nativeTurnIndex !== undefined) {
    index = artifact.socialEpisode.steps.findIndex((step) => step.turnIndex === selector.nativeTurnIndex);
  } else if (selector.nativeStepCount !== undefined) {
    index = selector.nativeStepCount - 1;
  }
  const step = artifact.socialEpisode.steps[index];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  return { index, step };
}

export function assertSafeCheckpointBoundary(artifact: MatchArtifact, stepIndex: number): void {
  const step = artifact.socialEpisode.steps[stepIndex];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  if (!resolveAgentSnapshotsAfterNativeStep(artifact, step) || step.actorSnapshotsHashAfterStep === undefined) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${stepIndex + 1}: agent snapshots are not recorded for this boundary.`
    );
  }
  if (!isSafeNativeCheckpointBoundary(artifact.socialEpisode.steps, stepIndex)) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from the middle of a native scheduler batch."
    );
  }
}

function isSafeNativeCheckpointBoundary(steps: SocialEpisodeArtifact["steps"], stepIndex: number): boolean {
  if (stepIndex < 0) return steps.length === 0;
  const step = steps[stepIndex];
  if (!step) return false;
  const nextStep = steps[stepIndex + 1];
  if (!step.batchId || nextStep?.batchId !== step.batchId) return true;
  return step.schedulerMode === "aec" && !step.atomic;
}

export function latestMessageSeqForNativePrefix(
  episode: MatchArtifact["socialEpisode"],
  steps: MatchArtifact["socialEpisode"]["steps"]
): number {
  let messageSeq = episode.execution?.initialMessageCount ?? 0;
  for (const step of steps) {
    if (step.messageSeqRange) messageSeq = Math.max(messageSeq, step.messageSeqRange[1]);
  }
  return messageSeq;
}

export function validateCheckpointAgentEvidence(checkpoint: HarnessCheckpoint, errors: string[]): void {
  const futureTraceIds = new Set<string>();
  const maxMessageSeq = checkpoint.source.lastMessageSeq ?? 0;
  const maxEventSeq = checkpoint.executionPrefix.steps.reduce(
    (max, step) => (step.eventSeqRange ? Math.max(max, step.eventSeqRange[1]) : max),
    0
  );
  for (const [agentIndex, agent] of checkpoint.agents.entries()) {
    validateAgentEvidenceNotBeyondBoundary({
      agent,
      maxMessageSeq,
      maxEventSeq,
      futureTraceIds,
      label: `agents[${agentIndex}]`,
      errors
    });
  }
}

export function validateAgentEvidenceNotBeyondBoundary(input: {
  agent: AgentHarnessState;
  maxMessageSeq: number;
  maxEventSeq: number;
  futureTraceIds: Set<string>;
  label: string;
  errors: string[];
}): void {
  for (const entry of input.agent.social?.journal?.entries ?? []) {
    if (entry.traceId && input.futureTraceIds.has(entry.traceId)) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} references future trace ${entry.traceId}.`);
    }
    if (entry.messageSeqRange && entry.messageSeqRange.end > input.maxMessageSeq) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq}.messageSeqRange references future social message seq.`);
    }
    if (entry.eventSeqRange && entry.eventSeqRange.end > input.maxEventSeq) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq}.eventSeqRange references future event seq.`);
    }
    for (const evidenceRef of entry.evidenceRefs ?? []) {
      if (evidenceRef.artifact === "trace" && evidenceRef.traceId && input.futureTraceIds.has(evidenceRef.traceId)) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future trace ${evidenceRef.traceId}.`);
      }
      if (
        (evidenceRef.artifact === "message" || evidenceRef.artifact === "delivery_receipt") &&
        evidenceRef.seq !== undefined &&
        evidenceRef.seq > input.maxMessageSeq
      ) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future message seq ${evidenceRef.seq}.`);
      }
      if (evidenceRef.artifact === "event" && evidenceRef.seq !== undefined && evidenceRef.seq > input.maxEventSeq) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future event seq ${evidenceRef.seq}.`);
      }
    }
  }
}

function failureReasonFromEventPayload(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload.message === "string") return payload.message;
  if (payload === undefined || payload === null) return null;
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export function validateEventSeqRange(range: [number, number], eventSeqs: Set<number>, label: string, errors: string[]): void {
  if (!isTupleRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!eventSeqs.has(seq)) errors.push(`${label} references missing event seq ${seq}.`);
  }
}

export function validateMessageSeqRange(range: [number, number] | undefined, messageSeqs: Set<number>, label: string, errors: string[]): void {
  if (!range) return;
  if (!isTupleRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!messageSeqs.has(seq)) errors.push(`${label} references missing social message seq ${seq}.`);
  }
}

export function validateAgentSnapshotFrames(artifact: MatchArtifact, playerIds: Set<string>, errors: string[]): void {
  const seen = new Set<string>();
  const referencedFrameIds = referencedAgentSnapshotFrameIds(artifact);
  for (const [index, frame] of (artifact.agentSnapshotFrames ?? []).entries()) {
    const label = `agentSnapshotFrames[${index}]`;
    if (frame.artifactVersion !== AGENT_SNAPSHOT_FRAME_VERSION) {
      errors.push(`${label}.artifactVersion must be ${AGENT_SNAPSHOT_FRAME_VERSION}.`);
    }
    if (frame.kind !== "agent-snapshot-frame") {
      errors.push(`${label}.kind must be agent-snapshot-frame.`);
    }
    if (!frame.frameId?.trim()) {
      errors.push(`${label}.frameId is missing.`);
    } else if (seen.has(frame.frameId)) {
      errors.push(`Duplicate agent snapshot frame id ${frame.frameId}.`);
    }
    seen.add(frame.frameId);
    // The domain-neutral envelope validator has already bound agentsHash to
    // the canonical frame payload. This pass adds Werewolf roster semantics.
    if (frame.frameId !== harnessAgentSnapshotFrameId(frame.agentsHash)) {
      errors.push(`${label}.frameId mismatch for agentsHash.`);
    }
    if (!referencedFrameIds.has(frame.frameId)) {
      errors.push(`${label}.frameId ${frame.frameId} is not referenced by any trajectory or social step.`);
    }
    validateStepAgentSnapshots({
      snapshots: frame.agents,
      snapshotHash: frame.agentsHash,
      playerIds,
      actorId: "",
      label,
      required: true,
      snapshotPayloadAlreadyValidated: true,
      errors
    });
    for (const [agentIndex, agent] of frame.agents.entries()) {
      for (const error of validateWerewolfAgentHarnessStateSnapshot(agent, {
        requireSocialState: true,
        requireSocialStateHash: true
      })) {
        errors.push(`${label}.agents[${agentIndex}].${error}`);
      }
    }
  }
}

function referencedAgentSnapshotFrameIds(artifact: MatchArtifact): Set<string> {
  const refs = new Set<string>();
  const framesByHash = new Map((artifact.agentSnapshotFrames ?? []).map((frame) => [frame.agentsHash, frame.frameId]));
  for (const step of artifact.trajectory) {
    if (step.agentSnapshotFrameIdAfterStep) refs.add(step.agentSnapshotFrameIdAfterStep);
    if (!step.agentSnapshotFrameIdAfterStep && step.agentSnapshotsHashAfterStep) {
      const frameId = framesByHash.get(step.agentSnapshotsHashAfterStep);
      if (frameId) refs.add(frameId);
    }
  }
  for (const step of artifact.socialEpisode.steps) {
    if (step.actorSnapshotFrameIdAfterStep) refs.add(step.actorSnapshotFrameIdAfterStep);
    if (!step.actorSnapshotFrameIdAfterStep && step.actorSnapshotsHashAfterStep) {
      const frameId = framesByHash.get(step.actorSnapshotsHashAfterStep);
      if (frameId) refs.add(frameId);
    }
  }
  return refs;
}

export function validateStepAgentSnapshots(input: {
  snapshots: AgentHarnessState[] | undefined;
  snapshotHash: string | undefined;
  playerIds: Set<string>;
  actorId: string;
  label: string;
  required: boolean;
  snapshotPayloadAlreadyValidated?: boolean;
  errors: string[];
}): void {
  if (!input.snapshots || !input.snapshotHash) {
    if (input.required) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep and agentSnapshotsHashAfterStep are required for recoverable prefix checkpoints.`);
    }
    return;
  }
  if (!input.snapshotPayloadAlreadyValidated) {
    const actualHash = hashStableState(input.snapshots);
    if (actualHash !== input.snapshotHash) {
      input.errors.push(`${input.label}.agentSnapshotsHashAfterStep mismatch: expected ${actualHash}, received ${input.snapshotHash}.`);
    }
  }
  const seen = new Set<string>();
  for (const [index, agent] of input.snapshots.entries()) {
    if (seen.has(agent.playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep[${index}] duplicates playerId ${agent.playerId}.`);
    }
    seen.add(agent.playerId);
    if (!input.playerIds.has(agent.playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep[${index}] references unknown player ${agent.playerId}.`);
    }
    if (!input.snapshotPayloadAlreadyValidated) {
      for (const error of validateWerewolfAgentHarnessStateSnapshot(agent, {
        requireSocialState: true,
        requireSocialStateHash: true
      })) {
        input.errors.push(`${input.label}.agentSnapshotsAfterStep[${index}].${error}`);
      }
    }
  }
  for (const playerId of input.playerIds) {
    if (!seen.has(playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep is missing agent state for player ${playerId}.`);
    }
  }
  if (input.actorId) {
    const actor = input.snapshots.find((agent) => agent.playerId === input.actorId);
    if (!actor) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep is missing acting agent ${input.actorId}.`);
    }
  }
}

export function validateAgentSnapshotFrameReference(input: {
  framesById: ReadonlyMap<string, AgentSnapshotFrame>;
  frameId: string | undefined;
  snapshotHash: string | undefined;
  label: string;
  fieldName: string;
  hashFieldName: string;
  errors: string[];
}): void {
  if (!input.frameId) return;
  const frame = input.framesById.get(input.frameId);
  if (!frame) {
    input.errors.push(`${input.label}.${input.fieldName} references missing agent snapshot frame ${input.frameId}.`);
    return;
  }
  if (input.snapshotHash && frame.agentsHash !== input.snapshotHash) {
    input.errors.push(
      `${input.label}.${input.fieldName} hash mismatch: ${input.hashFieldName}=${input.snapshotHash}, frame.agentsHash=${frame.agentsHash}.`
    );
  }
}

export function resolveAgentSnapshotsForValidation(
  step: HarnessStepRecord,
  framesById: ReadonlyMap<string, AgentSnapshotFrame>
): AgentHarnessState[] | undefined {
  if (step.agentSnapshotsAfterStep) return step.agentSnapshotsAfterStep;
  const frameId = step.agentSnapshotFrameIdAfterStep;
  const snapshotHash = step.agentSnapshotsHashAfterStep;
  if (!frameId || !snapshotHash) return undefined;
  const frame = framesById.get(frameId);
  return frame?.agentsHash === snapshotHash ? frame.agents : undefined;
}

export function validateMutationRange(
  range: { start: number; end: number } | undefined,
  seqs: Set<number>,
  label: string,
  errors: string[]
): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start <= 0 || range.end < range.start) {
    errors.push(`${label} must be a positive integer range with start <= end.`);
    return;
  }
  for (let seq = range.start; seq <= range.end; seq += 1) {
    if (!seqs.has(seq)) errors.push(`${label} references missing seq ${seq}.`);
  }
}

function isTupleRange(range: [number, number]): boolean {
  const [start, end] = range;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start;
}

export function sameRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

export function isForkParentTraceRef(artifact: MatchArtifact, traceId: string): boolean {
  const inheritedTraceIds = artifact.forkOf?.parentEvidenceTraceIds;
  if (Array.isArray(inheritedTraceIds)) {
    return inheritedTraceIds.includes(traceId);
  }
  const parentRunId = artifact.forkOf?.parentRunId;
  return Boolean(parentRunId && traceId.startsWith(`${parentRunId}:`));
}

export function inheritedEvidenceTraceIdsFromCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  const traceIds = new Set<string>();
  if (checkpoint.source.boundaryTraceId) traceIds.add(checkpoint.source.boundaryTraceId);
  for (const step of checkpoint.executionPrefix.steps) {
    if (step.traceId) traceIds.add(step.traceId);
  }
  for (const agent of checkpoint.agents) {
    for (const entry of agent.social?.journal?.entries ?? []) {
      if (entry.traceId) traceIds.add(entry.traceId);
      for (const evidenceRef of entry.evidenceRefs ?? []) {
        if (evidenceRef.artifact === "trace" && evidenceRef.traceId) traceIds.add(evidenceRef.traceId);
      }
    }
  }
  return [...traceIds].sort();
}

export function commandTypeFromUnknown(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  return typeof record?.type === "string" ? record.type : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
