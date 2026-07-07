import { createGame } from "../core/engine";
import type { GameConfig, MatchMetrics, Role, Team } from "../core/types";
import { TOURNAMENT_EXPERIMENT_VERSION, type NormalizedTournamentExperiment } from "./experiment";
import {
  buildProfileBalancedAgents,
  describeResolvedAssignments,
  profilesFromModels,
  resolveAgentConfigs,
  type HarnessAssignmentConfig,
  type ResolvedAgentAssignment
} from "./profiles";
import { buildMatchArtifact, type MatchArtifact } from "./artifacts";
import { runHarnessMatch } from "./runtime";
import type {
  AdversarialEvaluation,
  HarnessAgentConfig,
  HarnessAgentProfile,
  HarnessEvaluationReport,
  HarnessForkProvenance,
  HarnessReasoner,
  HarnessRunResult,
  HarnessStepRecord,
  PolicyName
} from "./types";
import type { SocialEpisodeArtifact } from "./social";

export interface TournamentOptions {
  models: string[];
  profiles?: HarnessAgentProfile[];
  games: number;
  seed: string;
  reasoner: HarnessReasoner;
  config?: Partial<GameConfig> & { roles?: Role[] };
  maxTransitions?: number;
  temperature?: number;
  assignment?: HarnessAssignmentConfig;
  continueOnError?: boolean;
  includeArtifacts?: boolean;
  artifactSink?: (record: TournamentMatchArtifactRecord) => void | Promise<void>;
  experiment?: NormalizedTournamentExperiment;
}

export interface TournamentMatchArtifactRecord {
  index: number;
  seed: string;
  runId: string;
  matchId?: string;
  artifact: MatchArtifact;
}

export interface TournamentEpisode {
  index: number;
  seed: string;
  runId?: string;
  matchId?: string;
  status: "completed" | "failed";
  harnessStatus?: HarnessRunResult["status"];
  winner?: Team;
  phase?: string;
  day?: number;
  metrics?: MatchMetrics;
  evaluation?: AdversarialEvaluation;
  evaluationReport?: HarnessEvaluationReport;
  forkOf?: HarnessForkProvenance;
  trajectory?: HarnessStepRecord[];
  socialEpisode?: SocialEpisodeArtifact;
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments: ResolvedAgentAssignment[];
  agents: Array<{
    playerId: string;
    seat: number;
    profileId?: string;
    model: string;
    role?: Role;
    team?: Team;
    policyName?: PolicyName;
    won?: boolean;
    reward?: number;
  }>;
  error?: string;
  artifact?: MatchArtifact;
}

export interface TournamentModelStats {
  model: string;
  seatGames: number;
  seatWins: number;
  villageSeatGames: number;
  villageSeatWins: number;
  werewolfSeatGames: number;
  werewolfSeatWins: number;
  roleGames: Record<Role, number>;
  roleWins: Record<Role, number>;
  harnessTurns: number;
  harnessErrors: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  rewardTotal: number;
  averageReward: number;
}

export interface TournamentProfileStats extends TournamentModelStats {
  profileId: string;
  policyName?: PolicyName;
}

export interface TournamentResult {
  experiment: NormalizedTournamentExperiment;
  seed: string;
  models: string[];
  profiles: HarnessAgentProfile[];
  gamesRequested: number;
  gamesCompleted: number;
  gamesFailed: number;
  maxTransitions?: number;
  assignment?: HarnessAssignmentConfig;
  episodes: TournamentEpisode[];
  modelStats: Record<string, TournamentModelStats>;
  profileStats: Record<string, TournamentProfileStats>;
  artifacts?: TournamentMatchArtifactRecord[];
}

export async function runTournament(options: TournamentOptions): Promise<TournamentResult> {
  const defaultTemperature = options.temperature ?? 0.7;
  const profiles = options.profiles?.length ? options.profiles : profilesFromModels(options.models, defaultTemperature);
  const assignment = options.assignment ?? { strategy: "profile-rotation" as const };
  if (profiles.length === 0) throw new Error("Tournament requires at least one Agent profile or model.");
  if (!Number.isInteger(options.games) || options.games <= 0) throw new Error("Tournament games must be a positive integer.");
  const models = Array.from(new Set(profiles.map((profile) => profile.model)));
  const experiment = buildEffectiveExperiment(options, { models, profiles, assignment, temperature: defaultTemperature });

  const episodes: TournamentEpisode[] = [];
  const artifactRecords: TournamentMatchArtifactRecord[] = [];
  const modelStats = initializeModelStats(models);
  const profileStats = initializeProfileStats(profiles);

  for (let index = 0; index < options.games; index += 1) {
    const seed = `${options.seed}:g${index + 1}`;
    const initialState = createGame({
      id: `tournament-${sanitizeId(options.seed)}-${index + 1}`,
      seed,
      config: options.config
    });
    const agents = resolveAgentConfigs(initialState.players, profiles, index, defaultTemperature, assignment);
    const resolvedAssignments = describeResolvedAssignments(initialState.players, agents);
    const runId = initialState.id;

    try {
      const result = await runHarnessMatch({
        initialState,
        agents,
        reasoner: options.reasoner,
        maxTransitions: options.maxTransitions
      });
      let artifactRecord: TournamentMatchArtifactRecord | undefined;
      if (options.includeArtifacts || options.artifactSink) {
        const artifact = buildMatchArtifact({
          runId,
          matchId: result.state.id,
          seed,
          models,
          profiles,
          assignment,
          resolvedAssignments,
          result
        });
        artifactRecord = {
          index,
          seed,
          runId,
          matchId: result.state.id,
          artifact
        };
        if (options.includeArtifacts) artifactRecords.push(artifactRecord);
        await options.artifactSink?.(artifactRecord);
      }
      const episode = summarizeEpisode(index, seed, result, agents, assignment, resolvedAssignments, {
        runId,
        matchId: result.state.id,
        artifact: options.includeArtifacts ? artifactRecord?.artifact : undefined
      });
      episodes.push(episode);
      if (episode.status === "completed") {
        accumulateCompletedEpisode(modelStats, profileStats, episode);
      } else if (!options.continueOnError) {
        break;
      }
    } catch (error) {
      const episode: TournamentEpisode = {
        index,
        seed,
        runId,
        matchId: initialState.id,
        status: "failed",
        assignment,
        resolvedAssignments,
        agents: initialState.players.map((player) => ({
          playerId: player.id,
          seat: player.seat,
          role: player.role,
          team: player.team,
          profileId: agents.find((agent) => agent.playerId === player.id)?.profileId,
          model: agents.find((agent) => agent.playerId === player.id)?.model ?? "unknown"
        })),
        error: error instanceof Error ? error.message : String(error)
      };
      episodes.push(episode);
      if (!options.continueOnError) break;
    }
  }

  return {
    experiment,
    seed: options.seed,
    models,
    profiles,
    gamesRequested: options.games,
    gamesCompleted: episodes.filter((episode) => episode.status === "completed").length,
    gamesFailed: episodes.filter((episode) => episode.status === "failed").length,
    maxTransitions: options.maxTransitions,
    assignment,
    episodes,
    modelStats,
    profileStats,
    artifacts: options.includeArtifacts ? artifactRecords : undefined
  };
}

function buildEffectiveExperiment(
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
    timeoutMs: options.experiment?.timeoutMs,
    temperature: runtime.temperature,
    json: options.experiment?.json ?? "summary",
    continueOnError: options.continueOnError ?? false,
    config: options.config
  };
}

export function buildRoleBalancedAgents(
  players: Array<{ id: string; seat: number }>,
  models: string[],
  episodeIndex: number,
  temperature: number
): HarnessAgentConfig[] {
  return buildProfileBalancedAgents(players, profilesFromModels(models, temperature), episodeIndex, temperature);
}

function summarizeEpisode(
  index: number,
  seed: string,
  result: HarnessRunResult,
  agents: HarnessAgentConfig[],
  assignment: HarnessAssignmentConfig,
  resolvedAssignments: ResolvedAgentAssignment[],
  artifactInfo?: {
    runId?: string;
    matchId?: string;
    artifact?: MatchArtifact;
  }
): TournamentEpisode {
  const modelByPlayer = new Map(agents.map((agent) => [agent.playerId, agent.model]));
  const profileByPlayer = new Map(agents.map((agent) => [agent.playerId, agent.profileId]));
  const policyByPlayer = new Map(result.agents.map((agent) => [agent.playerId, agent.policyName]));
  const rewardByPlayer = new Map(result.evaluation.agentRewards.map((reward) => [reward.playerId, reward.reward]));
  return {
    index,
    seed,
    runId: artifactInfo?.runId,
    matchId: artifactInfo?.matchId,
    status: result.status === "failed" ? "failed" : "completed",
    harnessStatus: result.status,
    winner: result.state.winner,
    phase: result.state.phase,
    day: result.state.day,
    metrics: result.metrics,
    evaluation: result.evaluation,
    evaluationReport: result.evaluationReport,
    forkOf: result.forkOf,
    trajectory: result.trajectory,
    socialEpisode: result.socialEpisode,
    assignment,
    resolvedAssignments,
    agents: result.state.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      profileId: profileByPlayer.get(player.id),
      model: modelByPlayer.get(player.id) ?? "unknown",
      role: player.role,
      team: player.team,
      policyName: policyByPlayer.get(player.id),
      won: result.state.winner ? player.team === result.state.winner : undefined,
      reward: rewardByPlayer.get(player.id)
    })),
    error: result.status === "failed" ? result.failureReason : undefined,
    artifact: artifactInfo?.artifact
  };
}

function accumulateCompletedEpisode(
  modelStats: Record<string, TournamentModelStats>,
  profileStats: Record<string, TournamentProfileStats>,
  episode: TournamentEpisode
): void {
  for (const agent of episode.agents) {
    accumulateAgentStats(modelStats[agent.model] ??= createEmptyStats(agent.model), agent);
    if (agent.profileId) {
      accumulateAgentStats(profileStats[agent.profileId] ??= createEmptyProfileStats({ id: agent.profileId, model: agent.model }), agent);
    }
  }

  for (const [modelName, usage] of Object.entries(episode.metrics?.modelUsage ?? {})) {
    const model = modelStats[modelName] ?? createEmptyStats(modelName);
    modelStats[modelName] = model;
    model.harnessTurns += usage.calls;
    model.promptTokens += usage.promptTokens;
    model.completionTokens += usage.completionTokens;
    model.latencyMs += usage.latencyMs;
  }

  for (const model of Object.values(modelStats)) {
    model.harnessErrors += episode.metrics?.harnessErrorCount ?? 0;
  }
  for (const step of episode.evaluation?.trajectory ?? []) {
    if (!step.profileId) continue;
    const profile = profileStats[step.profileId];
    if (profile) profile.harnessTurns += 1;
  }
  for (const profile of Object.values(profileStats)) {
    profile.harnessErrors += episode.metrics?.harnessErrorCount ?? 0;
  }
}

function accumulateAgentStats(stats: TournamentModelStats, agent: TournamentEpisode["agents"][number]): void {
  stats.seatGames += 1;
  if (agent.won) stats.seatWins += 1;
  if (agent.team === "village") {
    stats.villageSeatGames += 1;
    if (agent.won) stats.villageSeatWins += 1;
  }
  if (agent.team === "werewolves") {
    stats.werewolfSeatGames += 1;
    if (agent.won) stats.werewolfSeatWins += 1;
  }
  if (agent.role) {
    stats.roleGames[agent.role] += 1;
    if (agent.won) stats.roleWins[agent.role] += 1;
  }
  stats.rewardTotal += agent.reward ?? 0;
  stats.averageReward = round3(stats.rewardTotal / Math.max(1, stats.seatGames));
}

function initializeModelStats(models: string[]): Record<string, TournamentModelStats> {
  return Object.fromEntries(models.map((model) => [model, createEmptyStats(model)]));
}

function initializeProfileStats(profiles: HarnessAgentProfile[]): Record<string, TournamentProfileStats> {
  return Object.fromEntries(profiles.map((profile) => [profile.id, createEmptyProfileStats(profile)]));
}

function createEmptyStats(model: string): TournamentModelStats {
  return {
    model,
    seatGames: 0,
    seatWins: 0,
    villageSeatGames: 0,
    villageSeatWins: 0,
    werewolfSeatGames: 0,
    werewolfSeatWins: 0,
    roleGames: emptyRoleRecord(),
    roleWins: emptyRoleRecord(),
    harnessTurns: 0,
    harnessErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    rewardTotal: 0,
    averageReward: 0
  };
}

function createEmptyProfileStats(profile: Pick<HarnessAgentProfile, "id" | "model" | "policyName">): TournamentProfileStats {
  return {
    ...createEmptyStats(profile.model),
    profileId: profile.id,
    policyName: profile.policyName
  };
}

function emptyRoleRecord(): Record<Role, number> {
  return {
    villager: 0,
    werewolf: 0,
    seer: 0,
    witch: 0,
    hunter: 0
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
