import { isAgentPendingAction } from "../../core/pending";
import type { GameCommand, GameState } from "../../core/types";
import { providerFailureFromError, safeProviderFailureMessage } from "../providerFailure";
import { tryParseWerewolfHarnessTurnActionMetadata } from "../werewolfExecutionEvidence";
import type {
  SocialActorTurnIndexProvider,
  SocialDecisionFailureHook,
  SocialEnvironmentStepFailureHook,
  SocialSchedulerResolver,
  SocialTraceIdProvider
} from "../social";
import {
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  type HarnessErrorPayload,
  type HarnessRunOptions
} from "../types";
import type { WerewolfSocialObservation, WerewolfSocialPendingAction } from "./adapterTypes";
import { WerewolfSocialActorAdapter } from "./actorAdapter";

export function werewolfEventSeq(state: GameState): number {
  return state.events.at(-1)?.seq ?? 0;
}

export const werewolfLegacyTraceId: SocialTraceIdProvider<GameState, WerewolfSocialPendingAction> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return undefined;
  return `${context.state.id}:harness:${context.actorTurnIndex ?? context.turnIndex}:${context.actorId}:${context.state.phase}`;
};

// werewolfLegacySchedulerModeForBatch is defined below createWerewolfJointPhaseSchedulerResolver.

export const recordWerewolfDecisionFailure: SocialDecisionFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.decisionState;
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const model = actor?.state.model ?? context.actor?.profile.model ?? "unknown";
  const traceId =
    context.traceId ??
    `${state.id}:harness:${context.actorTurnIndex ?? context.turnIndex}:${context.pendingAction.actorId}:${state.phase}`;
  const providerFailure = providerFailureFromError(context.error);
  const payload: HarnessErrorPayload = {
    model,
    actionKind: context.pendingAction.kind,
    message: safeProviderFailureMessage(context.error, "Harness actor decision failed before a command could be committed."),
    traceId,
    ...(providerFailure ? { providerFailure } : {})
  };
  return {
    stage: context.failureStage,
    message: payload.message,
    causeName: context.error instanceof Error ? context.error.name : undefined,
    metadata: payload
  };
};

export const recordWerewolfEnvironmentStepFailure: SocialEnvironmentStepFailureHook<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  if (!isAgentPendingAction(context.pendingAction)) return;
  const state = context.failureState;
  const actor = context.actor instanceof WerewolfSocialActorAdapter ? context.actor : undefined;
  const metadata = tryParseWerewolfHarnessTurnActionMetadata(context.action.metadata, context.action.traceId);
  const model = metadata?.turnTrace.model ?? actor?.state.model ?? context.actor?.profile.model ?? "unknown";
  const actionKind = metadata?.turnTrace.actionKind ?? context.pendingAction.kind;
  const traceId =
    context.action.traceId ??
    metadata?.turnTrace.traceId ??
    `${state.id}:harness:${context.turnIndex}:${context.pendingAction.actorId}:${state.phase}`;
  const providerFailure = providerFailureFromError(context.error);
  const payload: HarnessErrorPayload = {
    model,
    actionKind,
    message: safeProviderFailureMessage(context.error, "Harness environment transition failed."),
    traceId
  };
  const attempts = metadata?.reasonerOutput.attempts;
  if (attempts !== undefined) payload.attempts = attempts;
  if (providerFailure) payload.providerFailure = providerFailure;
  return {
    stage: "environment_step",
    message: payload.message,
    causeName: context.error instanceof Error ? context.error.name : undefined,
    metadata: payload
  };
};

export function createWerewolfJointPhaseSchedulerResolver(
  jointPhaseScheduler: HarnessRunOptions["jointPhaseScheduler"] = DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
): SocialSchedulerResolver<GameState, WerewolfSocialPendingAction> {
  return (context) => {
    if (
      context.pendingActions.length > 0 &&
      context.pendingActions.every((action) => isAgentPendingAction(action) && (action.kind === "vote" || action.kind === "kill"))
    ) {
      return jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER;
    }
    return "aec";
  };
}

export const werewolfLegacySchedulerModeForBatch = createWerewolfJointPhaseSchedulerResolver(
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
);

export function createSequentialActorTurnIndexProvider(): SocialActorTurnIndexProvider<GameState, WerewolfSocialPendingAction> {
  let nextTurnIndex = 1;
  return (context) => {
    if (!isAgentPendingAction(context.pendingAction)) return undefined;
    const turnIndex = nextTurnIndex;
    nextTurnIndex += 1;
    return turnIndex;
  };
}
