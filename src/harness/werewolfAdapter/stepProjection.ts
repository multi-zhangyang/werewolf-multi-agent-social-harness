import { isAgentPendingAction } from "../../core/pending";
import type { PlayerView } from "../../core/types";
import type { SocialCommunicationBus } from "../social";
import { parseWerewolfHarnessTurnActionMetadata } from "../werewolfExecutionEvidence";
import type { AgentHarnessState, HarnessPlayerView, HarnessStepRecord } from "../types";
import {
  WEREWOLF_SYSTEM_ACTOR_ID,
  type AgentSnapshotAfterStep,
  type WerewolfGenericSocialStep,
  type WerewolfSocialStep,
  type WerewolfSocialStepMetadata
} from "./adapterTypes";
import { cloneJson } from "./internals";

export function toWerewolfSocialStep(step: HarnessStepRecord, metadata: WerewolfSocialStepMetadata): WerewolfSocialStep {
  return {
    traceId: step.traceId,
    turnIndex: step.turnIndex,
    batchId: metadata.batchId,
    batchIndex: metadata.batchIndex,
    batchSize: metadata.batchSize,
    actorId: step.actorId,
    profileId: step.profileId ?? step.actorId,
    schedulerMode: metadata.schedulerMode,
    atomic: false,
    resolutionPolicy: metadata.resolutionPolicy,
    pendingAction: cloneJson(step.pendingAction),
    observation: cloneJson(step.observation),
    action: {
      actorId: step.actorId,
      kind: step.command.type,
      command: cloneJson(step.command)
    },
    decisionStateHash: step.decisionStateHash,
    preStateHash: step.preStateHash,
    postStateHash: step.postStateHash,
    eventSeqRange: step.eventSeqRange,
    messageSeqRange: step.messageSeqRange
  };
}

export function projectWerewolfSocialStepToHarnessStep(
  step: WerewolfGenericSocialStep,
  agentSnapshot?: AgentSnapshotAfterStep
): HarnessStepRecord | undefined {
  if (step.actorId === WEREWOLF_SYSTEM_ACTOR_ID) return undefined;
  if (step.error) return undefined;
  if (step.observation.kind !== "player") {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: expected player observation.`);
  }
  if (!isAgentPendingAction(step.pendingAction)) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: expected agent pending action.`);
  }
  if (!step.preStateHash) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing preStateHash.`);
  }
  if (!step.postStateHash) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing postStateHash.`);
  }
  if (!step.eventSeqRange) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: missing eventSeqRange.`);
  }
  const metadata = parseWerewolfHarnessTurnActionMetadata(step.action.metadata, step.traceId);
  const stepAgentSnapshot = agentSnapshot ?? agentSnapshotFromSocialStep(step);
  if (metadata.turnTrace.traceId !== step.traceId) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: turnTrace traceId mismatch.`);
  }
  if (metadata.turnTrace.playerId !== step.actorId) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: turnTrace actor mismatch.`);
  }
  if (metadata.turnTrace.commandType !== step.action.command.type) {
    throw new Error(`Cannot project Werewolf social step ${step.traceId}: commandType mismatch.`);
  }
  return {
    traceId: step.traceId,
    turnIndex: metadata.turnIndex ?? step.turnIndex,
    actorId: step.actorId,
    profileId: step.profileId,
    model: metadata.turnTrace.model,
    pendingAction: cloneJson(step.pendingAction),
    observation: cloneJson(step.observation.view),
    decisionStateHash: step.decisionStateHash,
    preStateHash: step.preStateHash,
    policyPlan: cloneJson(metadata.policyPlan),
    reasonerOutput: cloneJson(metadata.reasonerOutput),
    command: cloneJson(step.action.command),
    turnTrace: cloneJson(metadata.turnTrace),
    actionArbitration: cloneJson(metadata.actionArbitration),
    agentStateHash: metadata.agentStateHash ?? metadata.turnTrace.agentStateHash,
    agentSnapshotsAfterStep: cloneJson(stepAgentSnapshot?.agents),
    agentSnapshotsHashAfterStep: stepAgentSnapshot?.hash,
    postStateHash: step.postStateHash,
    eventSeqRange: cloneJson(step.eventSeqRange),
    messageSeqRange: cloneJson(step.messageSeqRange)
  };
}

export function projectWerewolfSocialStepsToHarnessTrajectory(steps: WerewolfGenericSocialStep[]): HarnessStepRecord[] {
  return projectWerewolfSuccessfulSocialSteps(steps).map((step) => step.harnessStep);
}

export function assembleHarnessPlayerView(view: PlayerView, socialBus: SocialCommunicationBus): HarnessPlayerView {
  const social = socialBus.observe(view.you.id);
  return {
    ...cloneJson(view),
    social: {
      channels: social.channels,
      messages: social.messages
    }
  };
}

export function projectWerewolfSuccessfulSocialSteps(
  steps: WerewolfGenericSocialStep[],
  agentSnapshotsByTraceId: Map<string, AgentSnapshotAfterStep> = new Map()
): Array<{ genericStep: WerewolfGenericSocialStep; harnessStep: HarnessStepRecord }> {
  return steps.flatMap((genericStep) => {
    const harnessStep = projectWerewolfSocialStepToHarnessStep(genericStep, agentSnapshotsByTraceId.get(genericStep.traceId));
    return harnessStep ? [{ genericStep, harnessStep }] : [];
  });
}

export function attachAgentSnapshotsToSocialSteps(
  steps: WerewolfGenericSocialStep[],
  agentSnapshotsByTraceId: Map<string, AgentSnapshotAfterStep>
): void {
  for (const step of steps) {
    const snapshot = agentSnapshotsByTraceId.get(step.traceId);
    if (!snapshot) continue;
    // The capture map is discarded after attachment/projection, and the
    // harness-step projection clones its own copy, so the step can take
    // ownership of the captured snapshot without another full-roster clone.
    step.actorSnapshotsAfterStep = snapshot.agents;
    step.actorSnapshotsHashAfterStep = snapshot.hash;
  }
}

function agentSnapshotFromSocialStep(step: WerewolfGenericSocialStep): AgentSnapshotAfterStep | undefined {
  if (!step.actorSnapshotsAfterStep || !step.actorSnapshotsHashAfterStep) return undefined;
  return {
    agents: step.actorSnapshotsAfterStep as AgentHarnessState[],
    hash: step.actorSnapshotsHashAfterStep
  };
}
function werewolfSocialStepSchedulerMode(mode: WerewolfGenericSocialStep["schedulerMode"]): WerewolfSocialStepMetadata["schedulerMode"] {
  return mode;
}

export function toWerewolfLegacySocialSteps(
  gameId: string,
  steps: Array<{ genericStep: WerewolfGenericSocialStep; harnessStep: HarnessStepRecord }>
): WerewolfSocialStep[] {
  const metadataFor = createWerewolfLegacySocialStepMetadataProvider(gameId);
  return steps.map(({ genericStep, harnessStep }) => toWerewolfSocialStep(harnessStep, metadataFor(genericStep)));
}

function createWerewolfLegacySocialStepMetadataProvider(gameId: string): (step: WerewolfGenericSocialStep) => WerewolfSocialStepMetadata {
  let nextLegacyBatchIndex = 1;
  const batchByGenericId = new Map<string, { batchId: string; nextBatchPosition: number }>();
  return (step) => {
    const metadata = socialStepMetadataFor(step);
    if (metadata.schedulerMode !== "aec-batched-decision" && metadata.schedulerMode !== "parallel") return metadata;
    const genericBatchId = step.batchId ?? `${step.traceId}:batch`;
    let batch = batchByGenericId.get(genericBatchId);
    if (!batch) {
      batch = {
        batchId: `${gameId}:werewolf-batch:${nextLegacyBatchIndex}`,
        nextBatchPosition: 1
      };
      batchByGenericId.set(genericBatchId, batch);
      nextLegacyBatchIndex += 1;
    }
    return {
      ...metadata,
      batchId: batch.batchId,
      batchIndex: batch.nextBatchPosition++,
      batchSize: step.batchSize
    };
  };
}

function socialStepMetadataFor(step: WerewolfGenericSocialStep): WerewolfSocialStepMetadata {
  const schedulerMode = werewolfSocialStepSchedulerMode(step.schedulerMode);
  return {
    schedulerMode,
    resolutionPolicy:
      step.resolutionPolicy ??
      (schedulerMode === "parallel"
        ? "parallel-stepBatch"
        : schedulerMode === "aec-batched-decision"
          ? "sequential-apply-from-shared-decision-state"
          : "sequential-apply")
  };
}
