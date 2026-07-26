import { createGame } from "../../core/engine";
import { TOURNAMENT_EXPERIMENT_VERSION, type NormalizedTournamentExperiment } from "../experiment";
import {
  buildProfileBalancedAgents,
  profilesFromModels,
  type HarnessAssignmentConfig
} from "../profiles";
import type { MatchArtifact } from "../artifacts";
import type { GenericExperimentSpecV1, GenericJsonObject } from "../experimentSpec";
import type {
  HarnessAgentConfig,
  HarnessAgentProfile,
  WerewolfJointPhaseScheduler
} from "../types";
import {
  classifyHarnessReasonerExecution,
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS
} from "../types";
import {
  createWerewolfSocialDomainAdapterManifest,
  WEREWOLF_PROFILE_POLICY_SELECTOR_ID
} from "../werewolfAdapter";
import { createWerewolfResultEvaluationSuite } from "../werewolfResult";
import type { TournamentEpisode, TournamentOptions } from "./types";
import { sanitizeId } from "./stats";

export function buildWerewolfGenericExperimentSpec(input: {
  options: TournamentOptions;
  experiment: NormalizedTournamentExperiment;
  profiles: HarnessAgentProfile[];
  assignment: HarnessAssignmentConfig;
  defaultTemperature: number;
  jointPhaseScheduler: WerewolfJointPhaseScheduler;
}): GenericExperimentSpecV1 {
  const probe = createGame({ id: "werewolf-experiment-spec", seed: input.options.seed, config: input.options.config });
  const evaluatorIds = createWerewolfResultEvaluationSuite().map((evaluator) => evaluator.id);
  return {
    id: input.experiment.id,
    kind: "tournament",
    domainId: "werewolf",
    domainAdapter: createWerewolfSocialDomainAdapterManifest(probe.config.rulesetId),
    seed: input.options.seed,
    episodeCount: input.options.games,
    actorCount: probe.players.length,
    schedulerMode: "aec",
    profiles: input.profiles.map((profile) => ({
      id: profile.id,
      version: "1",
      policyId: WEREWOLF_PROFILE_POLICY_SELECTOR_ID,
      reasonerId: "werewolf-harness-reasoner",
      temperature: profile.temperature ?? input.defaultTemperature
    })),
    modelAssignments: input.profiles.map((profile) => ({ profileId: profile.id, modelId: profile.model })),
    assignmentPolicy: {
      id: `werewolf.assignment.${input.assignment.strategy ?? "profile-rotation"}`,
      version: "1",
      configuration: portableJsonObject(input.assignment)
    },
    ...(input.options.maxTransitions === undefined ? {} : { maxTransitions: input.options.maxTransitions }),
    timeoutPolicy: {
      id: "harness.deadline",
      version: "1",
      ...(input.experiment.timeoutMs === undefined ? {} : { runTimeoutMs: input.experiment.timeoutMs }),
      ...(input.options.executionLimits?.decisionTimeoutMs === undefined
        ? {}
        : { decisionTimeoutMs: input.options.executionLimits.decisionTimeoutMs })
    },
    retryPolicy: { id: "harness.episode-attempt", version: "1", maxAttempts: 1 },
    evaluatorIds,
    artifactPolicy: { id: "harness.canonical-episode", version: "1", visibility: "research-full" },
    // A zero-transition probe has no committed native boundary and therefore
    // cannot satisfy the checkpoint envelope's durable actor-snapshot proof.
    // Record that truth explicitly instead of claiming a final checkpoint the
    // runtime cannot lawfully publish.
    checkpointPolicy: input.options.maxTransitions === 0
      ? { id: "harness.checkpoint.none.zero-transition", version: "1", mode: "none" }
      : { id: "harness.final-checkpoint", version: "1", mode: "final" },
    ...(classifyHarnessReasonerExecution(input.options.reasoner) === "live-provider"
      ? { providerPolicy: { id: "openai-compatible.streaming", version: "1", stream: true as const } }
      : {}),
    continueOnError: input.options.continueOnError ?? false,
    domainConfig: portableJsonObject({
      gameConfig: structuredClone(probe.config),
      jointPhaseScheduler: input.jointPhaseScheduler
    })
  };
}

export function portableJsonObject(value: unknown): GenericJsonObject {
  return JSON.parse(JSON.stringify(value)) as GenericJsonObject;
}

export function durableWerewolfRunId(experimentId: string, specHash: string, index: number): string {
  const safeExperimentId = sanitizeId(experimentId).slice(0, 72) || "tournament";
  return `${safeExperimentId}-${specHash.slice(0, 12)}-g${index + 1}`;
}

export function summarizeArtifactEpisode(
  index: number,
  seed: string,
  artifact: MatchArtifact,
  assignment: HarnessAssignmentConfig,
  jointPhaseScheduler: WerewolfJointPhaseScheduler,
  includeArtifact: boolean
): TournamentEpisode {
  const agentStateByPlayer = new Map(artifact.agents.map((agent) => [agent.playerId, agent]));
  const rewardByPlayer = new Map(artifact.evaluation.agentRewards.map((reward) => [reward.playerId, reward.reward]));
  const assignmentByPlayer = new Map(artifact.resolvedAssignments.map((record) => [record.playerId, record]));
  return {
    index,
    seed,
    runId: artifact.runId,
    matchId: artifact.matchId,
    status: artifact.status,
    harnessStatus: artifact.status,
    jointPhaseScheduler,
    winner: artifact.finalState.winner,
    phase: artifact.finalState.phase,
    day: artifact.finalState.day,
    metrics: artifact.metrics,
    evaluation: artifact.evaluation,
    evaluationReport: artifact.evaluationReport,
    forkOf: artifact.forkOf,
    trajectory: artifact.trajectory,
    socialEpisode: artifact.socialEpisode,
    assignment,
    resolvedAssignments: artifact.resolvedAssignments,
    agents: artifact.finalState.players.map((player) => {
      const resolved = assignmentByPlayer.get(player.id);
      const agentState = agentStateByPlayer.get(player.id);
      return {
        playerId: player.id,
        seat: player.seat,
        profileId: resolved?.profileId,
        model: resolved?.model ?? agentState?.model ?? "unknown",
        role: player.role,
        team: player.team,
        policyName: agentState?.policyName,
        won: artifact.finalState.winner ? player.team === artifact.finalState.winner : undefined,
        reward: rewardByPlayer.get(player.id)
      };
    }),
    error: artifact.status === "failed" ? artifact.failureReason : undefined,
    ...(includeArtifact ? { artifact: structuredClone(artifact) } : {})
  };
}

export function buildEffectiveExperiment(
  options: TournamentOptions,
  runtime: {
    models: string[];
    profiles: HarnessAgentProfile[];
    assignment: HarnessAssignmentConfig;
    temperature: number;
  }
): NormalizedTournamentExperiment {
  return {
    version: TOURNAMENT_EXPERIMENT_VERSION,
    id: options.experiment?.id ?? options.seed,
    kind: "tournament",
    seed: options.seed,
    models: runtime.models,
    profiles: runtime.profiles,
    assignment: runtime.assignment,
    games: options.games,
    maxTransitions: options.maxTransitions,
    jointPhaseScheduler: resolveJointPhaseScheduler(options),
    timeoutMs: options.experiment?.timeoutMs,
    temperature: runtime.temperature,
    json: options.experiment?.json ?? "summary",
    continueOnError: options.continueOnError ?? false,
    config: options.config
  };
}

export function resolveJointPhaseScheduler(options: TournamentOptions): WerewolfJointPhaseScheduler {
  const requested = options.jointPhaseScheduler;
  const recorded = options.experiment?.jointPhaseScheduler;
  if (requested && recorded && requested !== recorded) {
    throw new Error(`Tournament scheduler mismatch: options=${requested}, experiment=${recorded}.`);
  }
  const scheduler = requested ?? recorded ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER;
  if (
    scheduler === "parallel" &&
    options.maxTransitions !== undefined &&
    options.maxTransitions < WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS
  ) {
    throw new Error(
      `jointPhaseScheduler=parallel requires maxTransitions >= ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS} (system.advance + seer.inspect + joint wolf batch).`
    );
  }
  return scheduler;
}

export function buildRoleBalancedAgents(
  players: Array<{ id: string; seat: number }>,
  models: string[],
  episodeIndex: number,
  temperature: number
): HarnessAgentConfig[] {
  return buildProfileBalancedAgents(players, profilesFromModels(models, temperature), episodeIndex, temperature);
}
