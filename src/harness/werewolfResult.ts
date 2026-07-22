import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState, MatchMetrics } from "../core/types";
import {
  createDeceptionBeliefShiftEvaluator,
  createDeceptionReputationAssociationEvaluator,
  createWerewolfEvaluationSuite,
  evaluateAdversarialMatch
} from "./evaluator";
import { runEvaluationRegistry, type HarnessEvaluator } from "./evaluation";
import { WEREWOLF_METRIC_PROMOTION_POLICY } from "./werewolfMetricPromotion";
import { hashStableState } from "./hash";
import { harnessFailureEvidenceFromEpisode } from "./executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "./werewolfExecutionEvidence";
import { isSocialStepCommitted, type SocialChannel, type SocialEpisodeArtifact, type SocialHarnessStep, type SocialMessage } from "./social";
import {
  createBetrayalLifecycleTemporalAssociationEvaluator,
  createCommitmentCoalitionAssociationEvaluator,
  createCommitmentCoalitionLifecycleTemporalAssociationEvaluator,
  createGossipExposureTemporalAssociationEvaluator,
  createNormSanctionLifecycleTemporalAssociationEvaluator,
  createSocialDynamicsEvaluator,
  createSocialFactIngestEvidenceEvaluator,
  createSocialStateEvaluator,
  createTrustRepairLifecycleTemporalAssociationEvaluator,
  createTrustRepairRelationshipTemporalAssociationEvaluator,
  createTrustRepairReputationTemporalAssociationEvaluator
} from "./socialEvaluator";
import type {
  AgentHarnessState,
  HarnessForkProvenance,
  HarnessPlayerView,
  HarnessRunResult,
  HarnessRunStatus,
  HarnessStepRecord,
  HarnessTurnTrace,
  WerewolfHarnessObservation
} from "./types";

export type WerewolfResultSocialStep = SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand>;

export type WerewolfResultEvaluator = HarnessEvaluator<
  GameState,
  MatchMetrics,
  SocialEpisodeArtifact<GameState, WerewolfHarnessObservation, import("../core/types").PendingAction, GameCommand>,
  unknown,
  AgentHarnessState,
  HarnessStepRecord
>;

/** Canonical deterministic evaluator registry used by Werewolf run results
 * and by the generic experiment control plane when binding evaluator ids. */
export function createWerewolfResultEvaluationSuite(
  additionalEvaluators: readonly WerewolfResultEvaluator[] = []
): WerewolfResultEvaluator[] {
  return [
    ...createWerewolfEvaluationSuite(),
    createSocialStateEvaluator(),
    createCommitmentCoalitionAssociationEvaluator(),
    createCommitmentCoalitionLifecycleTemporalAssociationEvaluator(),
    createNormSanctionLifecycleTemporalAssociationEvaluator(),
    createGossipExposureTemporalAssociationEvaluator(),
    createTrustRepairLifecycleTemporalAssociationEvaluator(),
    createTrustRepairRelationshipTemporalAssociationEvaluator(),
    createTrustRepairReputationTemporalAssociationEvaluator(),
    createBetrayalLifecycleTemporalAssociationEvaluator(),
    createDeceptionBeliefShiftEvaluator(),
    createDeceptionReputationAssociationEvaluator(),
    createSocialFactIngestEvidenceEvaluator(),
    createSocialDynamicsEvaluator(),
    ...additionalEvaluators
  ];
}

export interface BuildWerewolfHarnessRunResultOptions {
  status: HarnessRunStatus;
  truncationReason?: string;
  failureReason?: string;
  initialState: GameState;
  finalState: GameState;
  agentStates: AgentHarnessState[];
  trajectory: HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact<GameState, WerewolfHarnessObservation, import("../core/types").PendingAction, GameCommand>;
  forkOf?: HarnessForkProvenance;
  /**
   * Experimental/test-only evaluator extension. These remain advisory
   * postgame modules; they never affect environment authority or replay.
   */
  additionalEvaluators?: readonly WerewolfResultEvaluator[];
}

export function buildWerewolfHarnessRunResultFromParts(options: BuildWerewolfHarnessRunResultOptions): HarnessRunResult {
  const state = cloneJson(options.finalState);
  const agentStates = cloneJson(options.agentStates);
  const socialEpisode = cloneJson(options.socialEpisode);
  const metrics = collectWerewolfHarnessMetrics(state, socialEpisode);
  socialEpisode.metrics = {
    ...(socialEpisode.metrics ?? {}),
    winner: metrics.winner ?? null,
    days: metrics.days,
    harnessTurnCount: metrics.harnessTurnCount,
    harnessErrorCount: metrics.harnessErrorCount
  };
  const evaluationReport = runEvaluationRegistry({
    id: `${state.id}:evaluation`,
    context: {
      id: state.id,
      status: options.status,
      initialState: options.initialState,
      finalState: state,
      agents: agentStates,
      trajectory: options.trajectory,
      metrics,
      socialEpisode
    },
    evaluators: createWerewolfResultEvaluationSuite(options.additionalEvaluators),
    promotionPolicy: WEREWOLF_METRIC_PROMOTION_POLICY
  });
  // Compatibility result evaluation is a pure domain reduction, not a
  // registry output. A failed optional/experimental evaluator must not make a
  // completed environment trajectory disappear or fabricate a zero result.
  const evaluation = evaluateAdversarialMatch(state, agentStates, socialEpisode);
  return {
    status: options.status,
    truncationReason: options.truncationReason,
    failureReason: options.failureReason,
    failureStateHash: options.status === "failed" ? hashStableState(state) : undefined,
    initialState: cloneJson(options.initialState),
    state,
    metrics,
    evaluation,
    evaluationReport,
    trajectory: cloneJson(options.trajectory),
    socialEpisode,
    agents: agentStates,
    forkOf: cloneJson(options.forkOf)
  };
}

export function collectWerewolfHarnessMetrics(state: GameState, socialEpisode?: unknown): MatchMetrics {
  const allTurns = werewolfHarnessTurnEvidenceFromEpisode(socialEpisode);
  const turns = allTurns.filter(({ step }) => isSocialStepCommitted(step));
  const errors = harnessFailureEvidenceFromEpisode(socialEpisode);
  const usage: MatchMetrics["modelUsage"] = {};
  let totalLatency = 0;
  for (const event of allTurns) {
    const payload = event.trace;
    // A policy-only actor may still retain a profile model label for
    // experiment assignment, but it did not make a provider/model call.
    // Historical traces without a source predate this distinction and retain
    // their reasoner-backed interpretation.
    if (payload.cognitionSource === "policy") continue;
    usage[payload.model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
    usage[payload.model].calls += 1;
    usage[payload.model].promptTokens += payload.promptTokens ?? 0;
    usage[payload.model].completionTokens += payload.completionTokens ?? 0;
    usage[payload.model].latencyMs += payload.latencyMs;
    totalLatency += payload.latencyMs;
  }

  const byId = new Map(state.players.map((player) => [player.id, player]));
  const dayVotes = state.votes.filter(
    (vote) => (vote.kind ?? "exile") === "exile" && !vote.abstain && vote.targetId
  );
  const wolfVotes = dayVotes.filter((vote) => byId.get(vote.voterId)?.team === "werewolves");
  const villageVotes = dayVotes.filter((vote) => byId.get(vote.voterId)?.team === "village");
  const wolfSurvivalDays = state.players
    .filter((player) => player.role === "werewolf")
    .map((player) => player.eliminatedAt?.day ?? state.day);

  return {
    winner: state.winner,
    days: state.day,
    totalDeaths: state.deaths.length,
    totalSpeeches: state.speeches.length,
    totalVotes: state.votes.length,
    harnessTurnCount: turns.length,
    harnessErrorCount: errors.length,
    averageLatencyMs: allTurns.length ? Math.round(totalLatency / allTurns.length) : 0,
    wolfVoteAccuracy: wolfVotes.length
      ? wolfVotes.filter((vote) => byId.get(vote.targetId ?? "")?.team === "village").length / wolfVotes.length
      : 0,
    villageVoteAccuracy: villageVotes.length
      ? villageVotes.filter((vote) => byId.get(vote.targetId ?? "")?.team === "werewolves").length / villageVotes.length
      : 0,
    deceptionSurvivalScore: wolfSurvivalDays.length
      ? wolfSurvivalDays.reduce((sum, days) => sum + days, 0) / wolfSurvivalDays.length
      : 0,
    modelUsage: usage
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
