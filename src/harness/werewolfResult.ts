import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState, MatchMetrics } from "../core/types";
import { createWerewolfEvaluationSuite, WEREWOLF_ADVERSARIAL_EVALUATOR_ID } from "./evaluator";
import { runEvaluationRegistry } from "./evaluation";
import { hashStableState } from "./hash";
import type { SocialChannel, SocialEpisodeArtifact, SocialHarnessStep, SocialMessage } from "./social";
import {
  createCommitmentCoalitionAssociationEvaluator,
  createCommitmentCoalitionLifecycleTemporalAssociationEvaluator,
  createSocialDynamicsEvaluator,
  createSocialFactIngestEvidenceEvaluator,
  createSocialStateEvaluator
} from "./socialEvaluator";
import type {
  AdversarialEvaluation,
  AgentHarnessState,
  HarnessForkProvenance,
  HarnessPlayerView,
  HarnessRunResult,
  HarnessRunStatus,
  HarnessStepRecord,
  HarnessTurnTrace
} from "./types";

export type WerewolfResultSocialStep = SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand>;

export interface BuildWerewolfHarnessRunResultOptions {
  status: HarnessRunStatus;
  truncationReason?: string;
  failureReason?: string;
  initialState: GameState;
  finalState: GameState;
  agentStates: AgentHarnessState[];
  trajectory: HarnessStepRecord[];
  socialSteps: WerewolfResultSocialStep[];
  messages: SocialMessage[];
  channels: SocialChannel[];
  forkOf?: HarnessForkProvenance;
}

export function buildWerewolfHarnessRunResultFromParts(options: BuildWerewolfHarnessRunResultOptions): HarnessRunResult {
  const state = cloneJson(options.finalState);
  const agentStates = cloneJson(options.agentStates);
  const metrics = collectWerewolfHarnessMetrics(state);
  const socialEpisode = buildWerewolfSocialEpisode({
    id: state.id,
    status: options.status,
    truncationReason: options.truncationReason,
    failureReason: options.failureReason,
    initialState: options.initialState,
    finalState: state,
    agents: agentStates,
    trajectory: options.trajectory,
    socialSteps: options.socialSteps,
    messages: options.messages,
    channels: options.channels,
    metrics
  });
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
    evaluators: [
      ...createWerewolfEvaluationSuite(),
      createSocialStateEvaluator(),
      createCommitmentCoalitionAssociationEvaluator(),
      createCommitmentCoalitionLifecycleTemporalAssociationEvaluator(),
      createSocialFactIngestEvidenceEvaluator(),
      createSocialDynamicsEvaluator()
    ]
  });
  const evaluation = evaluationReport.outputs[WEREWOLF_ADVERSARIAL_EVALUATOR_ID] as AdversarialEvaluation;
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

export function collectWerewolfHarnessMetrics(state: GameState): MatchMetrics {
  const turns = state.events.filter((event) => event.type === "harness.turn");
  const errors = state.events.filter((event) => event.type === "harness.error");
  const usage: MatchMetrics["modelUsage"] = {};
  let totalLatency = 0;
  for (const event of turns) {
    const payload = event.payload as HarnessTurnTrace;
    usage[payload.model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
    usage[payload.model].calls += 1;
    usage[payload.model].promptTokens += payload.promptTokens ?? 0;
    usage[payload.model].completionTokens += payload.completionTokens ?? 0;
    usage[payload.model].latencyMs += payload.latencyMs;
    totalLatency += payload.latencyMs;
  }

  const byId = new Map(state.players.map((player) => [player.id, player]));
  const dayVotes = state.votes.filter((vote) => !vote.abstain && vote.targetId);
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
    averageLatencyMs: turns.length ? Math.round(totalLatency / turns.length) : 0,
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

export function buildWerewolfSocialEpisode(options: {
  id: string;
  status: HarnessRunStatus;
  truncationReason?: string;
  failureReason?: string;
  initialState: GameState;
  finalState: GameState;
  agents: AgentHarnessState[];
  trajectory: HarnessStepRecord[];
  socialSteps: WerewolfResultSocialStep[];
  channels: SocialChannel[];
  messages: SocialMessage[];
  metrics: MatchMetrics;
}): SocialEpisodeArtifact<GameState, HarnessPlayerView, AgentPendingAction, GameCommand> {
  return {
    id: options.id,
    status: options.status,
    schedulerMode: "aec",
    profiles: options.agents.map((agent) => ({
      id: agent.profileId ?? agent.playerId,
      model: agent.model,
      temperature: agent.temperature,
      role: options.initialState.players.find((player) => player.id === agent.playerId)?.role,
      team: options.initialState.players.find((player) => player.id === agent.playerId)?.team,
      policyId: agent.policyName
    })),
    channels: cloneJson(options.channels),
    initialState: cloneJson(options.initialState),
    finalState: cloneJson(options.finalState),
    steps: cloneJson(options.socialSteps),
    messages: cloneJson(options.messages),
    metrics: {
      winner: options.metrics.winner ?? null,
      days: options.metrics.days,
      harnessTurnCount: options.metrics.harnessTurnCount,
      harnessErrorCount: options.metrics.harnessErrorCount
    },
    truncationReason: options.truncationReason,
    failureReason: options.failureReason,
    error: options.failureReason
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
