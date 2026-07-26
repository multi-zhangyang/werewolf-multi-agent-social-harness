import { type SocialDomainAdapterManifest } from "../domainAdapter";
import { type RecordedSocialAgentStateAuditResult } from "../episodeArtifacts";
import { type SocialEnvironment, type SocialEpisodeArtifact, type SocialExposureRecord, type SocialHarnessStep, type SocialMessage } from "../social";
/**
 * Domain-neutral replay result. Replay consumes recorded commands and a
 * deterministic environment only: it creates no actor, policy, reasoner,
 * provider client, or model request.
 */
export interface SocialEpisodeReplayResult<TState = unknown> {
  ok: boolean;
  replayedSteps: number;
  replayedBatches: number;
  rejectedSteps: number;
  finalState: TState;
  finalHash?: string;
  expectedFinalHash?: string;
  messages: SocialMessage[];
  messagesHash?: string;
  expectedMessagesHash?: string;
  /** Present when the episode contains inline snapshots or an external frame registry. */
  agentStateAudit?: RecordedSocialAgentStateAuditResult;
  mismatches: string[];
}

/**
 * Domain adapters can bind recorded pending-action evidence to the actual
 * replay pre-state without making the generic replayer import a domain. This
 * remains a pure audit callback: replay still creates no actor, policy,
 * reasoner, or provider.
 */
export type SocialRecordedStepValidator<TState, TObservation, TPending, TCommand> = (
  step: SocialHarnessStep<TObservation, TPending, TCommand>,
  context: {
    index: number;
    state: TState;
    pendingActions: readonly TPending[];
    schedulerMode: "aec" | "aec-batched-decision" | "parallel";
    batch: readonly SocialHarnessStep<TObservation, TPending, TCommand>[];
  }
) => readonly string[];

/**
 * Pure, domain-owned validation of a durable actor-state snapshot recorded at
 * a completed receipt boundary. The generic replayer supplies only recorded
 * evidence: environment snapshots, committed messages, scoped observations,
 * and the prior durable snapshot. It never instantiates an actor, evaluates a
 * policy, parses free text, or calls a reasoner/provider.
 *
 * The callback runs once at the end of a complete native batch. For a true
 * parallel batch that means one invocation after the joint `stepBatch()` and
 * all recorded receipts, never against an invented per-member intermediary.
 */
export type SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState> = (input: {
  /** Recorded prefix only; no future steps or messages are exposed. */
  episodePrefix: Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "steps" | "messages" | "channels" | "runtimeActorIds">;
  /** Last native step in this completed receipt boundary. */
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  /** Zero-based index of `step` in the full episode. */
  stepIndex: number;
  /** One sequential step or every member of one completed parallel batch. */
  batch: readonly SocialHarnessStep<TObservation, TPending, TCommand>[];
  /** Durable actor state from the preceding captured receipt boundary, when available. */
  priorAgents?: readonly TAgentState[];
  /** Durable actor state recorded after this receipt boundary. */
  recordedAgents: readonly TAgentState[];
  /** Exact replay environment state before this native boundary. */
  stateBefore: TState;
  /** Exact replay environment state after this native boundary. */
  stateAfter: TState;
  /** All committed social messages through this boundary. */
  committedMessages: readonly SocialMessage[];
  /**
   * Canonical actor-scoped message exposures derived from observations in the
   * recorded prefix. The helper has already enforced channel/runtime-audience
   * rules; it is evidence, not an inference from message text.
   */
  scopedExposureRecords: readonly SocialExposureRecord[];
  /**
   * Channel-authorized message slices at this committed boundary. These do
   * not replace `scopedExposureRecords`: a validator that needs proof of an
   * actual observation must use the latter.
   */
  visibleMessagesByActor: Readonly<Record<string, readonly SocialMessage[]>>;
}) => readonly string[];

/**
 * Canonical artifact acceptance must make the private-state semantic policy
 * explicit. A domain may opt out only when it records no durable actor state;
 * callers can no longer silently omit a validator while still claiming that a
 * state-bearing artifact received semantic verification.
 */
export type SocialRecordedAgentStateValidationPolicy<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState
> =
  | {
      mode: "validate";
      validator: SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState>;
    }
  | {
      mode: "none";
      reason: string;
    };

export interface SocialArtifactVerificationRuntime<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState
> {
  domainAdapter: SocialDomainAdapterManifest;
  createEnvironment(initialState: TState): SocialEnvironment<TState, TObservation, TPending, TCommand>;
  hashState: (state: TState) => string;
  hashMessages: (messages: SocialMessage[]) => string;
  eventSeq?: (state: TState) => number;
  validateRecordedStep: SocialRecordedStepValidator<TState, TObservation, TPending, TCommand>;
  recordedAgentState: SocialRecordedAgentStateValidationPolicy<TState, TObservation, TPending, TCommand, TAgentState>;
}

export interface HarnessEpisodeArtifactVerificationResult<TState> {
  ok: boolean;
  validationMode: "validate" | "none" | "invalid";
  structureErrors: string[];
  configurationErrors: string[];
  replay?: SocialEpisodeReplayResult<TState>;
  mismatches: string[];
}
