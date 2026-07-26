import type { AgentPendingAction } from "../../core/pending";
import type { GameCommand, GameState, PendingAction, PlayerState } from "../../core/types";
import type { WerewolfAgentActor } from "../actor";
import type {
  SocialActorTurnIndexProvider,
  SocialAgentProfile,
  SocialChannel,
  SocialDecisionFailureHook,
  SocialEnvironmentStepFailureHook,
  SocialEpisodeArtifact,
  SocialHarnessStep,
  SocialReasonerCallReport,
  SocialSchedulerResolver,
  SocialTraceIdProvider
} from "../social";
import type { WerewolfHarnessTurnActionMetadata } from "../werewolfExecutionEvidence";
import type {
  AgentHarnessState,
  HarnessAgentConfig,
  HarnessPlayerView,
  HarnessReasoner,
  HarnessRunOptions,
  HarnessStepRecord,
  PolicyPlan,
  ReasonerOutputSummary,
  WerewolfHarnessObservation
} from "../types";
import type { WerewolfSocialActorAdapter } from "./actorAdapter";

export const WEREWOLF_SYSTEM_ACTOR_ID = "system";

export const WEREWOLF_SYSTEM_PROFILE: SocialAgentProfile = {
  id: WEREWOLF_SYSTEM_ACTOR_ID,
  model: "deterministic-environment",
  policyId: "system-transition",
  metadata: { authority: "environment" }
};

/** Portable profile-policy identity recorded by the generic experiment plane.
 * The concrete role-aware policy remains in AgentHarnessState and decision
 * traces; this selector states that Werewolf resolves it after role assignment. */
export const WEREWOLF_PROFILE_POLICY_SELECTOR_ID = "werewolf.role-policy-selector.v1";

export type WerewolfSocialPendingAction = PendingAction;

export type WerewolfSocialObservation = WerewolfHarnessObservation;

export interface WerewolfSocialActorAdapterOptions {
  actor: WerewolfAgentActor;
  /** Optional advisory component; policy-only execution must not manufacture
   * a synthetic reasoner merely to enter the production scaffold. */
  reasoner?: HarnessReasoner;
  players: PlayerState[];
  tracePrefix?: string;
  /**
   * The production path uses the generic receipt-gated scaffold with the
   * canonical AgentHarnessState bridge. Legacy mode remains only for direct
   * compatibility tests and migration parity baselines.
   */
  executionMode?: "legacy" | "scaffold";
}

export interface WerewolfMessageDraftInput {
  players: PlayerState[];
  traceId: string;
  turnIndex: number;
  actorId: string;
  pendingAction: AgentPendingAction;
  command: GameCommand;
  policyPlan: PolicyPlan;
  observation: HarnessPlayerView;
  reasonerOutput: ReasonerOutputSummary;
}

export type WerewolfSocialStep = SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand>;
export type WerewolfGenericSocialStep = SocialHarnessStep<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;

export type WerewolfSocialActionMetadata = WerewolfHarnessTurnActionMetadata;

export interface WerewolfSocialStepMetadata {
  schedulerMode: "aec" | "aec-batched-decision" | "parallel";
  resolutionPolicy: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
}

export type WerewolfSocialHarnessPrefixSchedulerMode = "aec" | "aec-batched-decision" | "simultaneous-batch" | "parallel";

export interface WerewolfSocialHarnessPrefixOptions
  extends Pick<
    HarnessRunOptions,
    | "initialState"
    | "agents"
    | "initialAgentStates"
    | "initialSocialChannels"
    | "initialSocialMessages"
    | "reasoner"
    | "maxTransitions"
    | "executionLimits"
    | "jointPhaseScheduler"
    | "recordAgentSnapshots"
    | "onLivePublicState"
  > {
  id?: string;
  schedulerMode?: WerewolfSocialHarnessPrefixSchedulerMode;
  traceIdForDecision?: SocialTraceIdProvider<GameState, WerewolfSocialPendingAction>;
  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<GameState, WerewolfSocialPendingAction>;
  schedulerModeForBatch?: SocialSchedulerResolver<GameState, WerewolfSocialPendingAction>;
  onDecisionFailure?: SocialDecisionFailureHook<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
}

export interface WerewolfSocialHarnessPrefixResult {
  artifact: SocialEpisodeArtifact<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>;
  trajectory: HarnessStepRecord[];
  socialSteps: WerewolfSocialStep[];
  actors: WerewolfSocialActorAdapter[];
  agentStates: AgentHarnessState[];
  channels: SocialChannel[];
}

export interface AgentSnapshotAfterStep {
  agents: AgentHarnessState[];
  hash: string;
}

export interface WerewolfHarnessTurnProbeOptions {
  state: GameState;
  action: AgentPendingAction;
  agent: HarnessAgentConfig;
  reasoner?: HarnessReasoner;
}

export interface ReasonerCallTransaction {
  traceId: string;
  state: "open" | "closed";
  reports: SocialReasonerCallReport[];
}

export interface ReasonerCallTransactionContext {
  transactionId: string;
  traceId: string;
}
