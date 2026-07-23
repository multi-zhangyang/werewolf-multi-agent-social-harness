import path from "node:path";
import { createGame } from "../core/engine";
import { assertRuntimeModelsAvailable } from "../agents/schema";
import type { GameConfig, GameState, MatchMetrics, Role, Team } from "../core/types";
import { TOURNAMENT_EXPERIMENT_VERSION, type NormalizedTournamentExperiment } from "./experiment";
import {
  buildProfileBalancedAgents,
  describeResolvedAssignments,
  profilesFromModels,
  resolveAgentConfigs,
  type HarnessAssignmentConfig,
  type ResolvedAgentAssignment
} from "./profiles";
import {
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  validateHarnessCheckpoint,
  validateMatchArtifactIntegrity,
  type HarnessCheckpoint,
  type MatchArtifact
} from "./artifacts";
import { HarnessEpisodeArtifactStore } from "./episodeArtifactStore";
import { HarnessExperimentRunStore } from "./experimentRunStore";
import {
  runGenericExperiment,
  type GenericExperimentArtifactStore,
  type GenericExperimentRunStore
} from "./experimentOrchestrator";
import type { GenericExperimentSpecV1, GenericJsonObject } from "./experimentSpec";
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
  PolicyName,
  WerewolfJointPhaseScheduler
} from "./types";
import {
  classifyHarnessReasonerExecution,
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS
} from "./types";
import { countSocialStepCommitsByActor, isSocialStepCommitted, type SocialEpisodeArtifact } from "./social";
import type { SocialExecutionLimits } from "./social";
import { runTournamentEpisodes } from "./tournamentRunner";
import {
  createWerewolfSocialDomainAdapterManifest,
  WEREWOLF_PROFILE_POLICY_SELECTOR_ID
} from "./werewolfAdapter";
import { createWerewolfResultEvaluationSuite } from "./werewolfResult";

export interface TournamentOrchestrationOptions {
  artifactStore: GenericExperimentArtifactStore<MatchArtifact, HarnessCheckpoint>;
  runStore: GenericExperimentRunStore<MatchArtifact>;
  /** Stable durable run authority. Defaults to the normalized experiment id. */
  runSetId?: string;
}

export interface OpenedTournamentOrchestrationOptions extends TournamentOrchestrationOptions {
  artifactStore: HarnessEpisodeArtifactStore<MatchArtifact, HarnessCheckpoint>;
  runStore: HarnessExperimentRunStore<MatchArtifact>;
}

export async function openTournamentOrchestration(options: {
  baseDirectory: string;
  runSetId?: string;
}): Promise<OpenedTournamentOrchestrationOptions> {
  const root = path.resolve(options.baseDirectory);
  const artifactStore = await HarnessEpisodeArtifactStore.open<MatchArtifact, HarnessCheckpoint>({
    baseDirectory: path.join(root, "episodes"),
    verifyArtifact: (artifact) => {
      const mismatches = validateMatchArtifactIntegrity(artifact);
      return { ok: mismatches.length === 0, mismatches };
    },
    verifyCheckpoint: (checkpoint) => {
      const mismatches = validateHarnessCheckpoint(checkpoint);
      return { ok: mismatches.length === 0, mismatches };
    }
  });
  const runStore = await HarnessExperimentRunStore.open({
    baseDirectory: path.join(root, "runs"),
    episodeStore: artifactStore
  });
  return {
    artifactStore,
    runStore,
    ...(options.runSetId === undefined ? {} : { runSetId: options.runSetId })
  };
}

export interface TournamentOptions {
  models: string[];
  profiles?: HarnessAgentProfile[];
  games: number;
  seed: string;
  reasoner: HarnessReasoner;
  config?: Partial<GameConfig> & { roles?: Role[] };
  maxTransitions?: number;
  executionLimits?: SocialExecutionLimits;
  jointPhaseScheduler?: WerewolfJointPhaseScheduler;
  temperature?: number;
  assignment?: HarnessAssignmentConfig;
  continueOnError?: boolean;
  includeArtifacts?: boolean;
  artifactSink?: (record: TournamentMatchArtifactRecord) => void | Promise<void>;
  experiment?: NormalizedTournamentExperiment;
  /** When present, production execution uses the V2 durable experiment
   * lifecycle instead of calling the episode scheduler directly. */
  orchestration?: TournamentOrchestrationOptions;
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
  /** Tournament-level status preserves the harness lifecycle outcome. */
  status: HarnessRunResult["status"] | "failed";
  harnessStatus?: HarnessRunResult["status"];
  /** Recorded control-plane condition for this episode's joint action phases. */
  jointPhaseScheduler?: WerewolfJointPhaseScheduler;
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
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
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
  /** Present on new results; optional for legacy artifact inputs. */
  gamesTruncated?: number;
  /** Present on new results; optional for legacy artifact inputs. */
  gamesUnstarted?: number;
  maxTransitions?: number;
  assignment?: HarnessAssignmentConfig;
  episodes: TournamentEpisode[];
  modelStats: Record<string, TournamentModelStats>;
  profileStats: Record<string, TournamentProfileStats>;
  artifacts?: TournamentMatchArtifactRecord[];
}

interface WerewolfTournamentPreparedEpisode {
  initialState: GameState;
  agents: HarnessAgentConfig[];
  resolvedAssignments: ResolvedAgentAssignment[];
  runId: string;
}

interface WerewolfTournamentExecution {
  result: HarnessRunResult;
  artifactInfo?: {
    runId: string;
    matchId: string;
    artifact?: MatchArtifact;
  };
}

export async function runTournament(options: TournamentOptions): Promise<TournamentResult> {
  if (options.orchestration) return runDurableTournament(options);
  const defaultTemperature = options.temperature ?? 0.7;
  const profiles = options.profiles?.length ? options.profiles : profilesFromModels(options.models, defaultTemperature);
  const assignment = options.assignment ?? { strategy: "profile-rotation" as const };
  if (profiles.length === 0) throw new Error("Tournament requires at least one Agent profile or model.");
  if (!Number.isInteger(options.games) || options.games <= 0) throw new Error("Tournament games must be a positive integer.");
  const models = Array.from(new Set(profiles.map((profile) => profile.model)));
  assertRuntimeModelsAvailable(models, "Tournament");
  const jointPhaseScheduler = resolveJointPhaseScheduler(options);
  const experiment = buildEffectiveExperiment(options, { models, profiles, assignment, temperature: defaultTemperature });

  const episodes: TournamentEpisode[] = [];
  const artifactRecords: TournamentMatchArtifactRecord[] = [];
  const modelStats = initializeModelStats(models);
  const profileStats = initializeProfileStats(profiles);

  const control = await runTournamentEpisodes<WerewolfTournamentPreparedEpisode, WerewolfTournamentExecution>({
    games: options.games,
    seed: options.seed,
    abortSignal: options.executionLimits?.abortSignal,
    continueOnError: options.continueOnError,
    prepareEpisode: ({ index, seed }) => {
      const initialState = createGame({
        id: `tournament-${sanitizeId(options.seed)}-${index + 1}`,
        seed,
        config: options.config
      });
      const agents = resolveAgentConfigs(initialState.players, profiles, index, defaultTemperature, assignment);
      return {
        initialState,
        agents,
        resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
        runId: initialState.id
      };
    },
    runEpisode: async (prepared, { index, seed }) => {
      const result = await runHarnessMatch({
        initialState: prepared.initialState,
        agents: prepared.agents,
        reasoner: options.reasoner,
        maxTransitions: options.maxTransitions,
        executionLimits: options.executionLimits,
        jointPhaseScheduler
      });
      let artifactRecord: TournamentMatchArtifactRecord | undefined;
      if (options.includeArtifacts || options.artifactSink) {
        const artifact = buildMatchArtifact({
          runId: prepared.runId,
          matchId: result.state.id,
          seed,
          models,
          profiles,
          assignment,
          resolvedAssignments: prepared.resolvedAssignments,
          result
        });
        artifactRecord = {
          index,
          seed,
          runId: prepared.runId,
          matchId: result.state.id,
          artifact
        };
        if (options.includeArtifacts) artifactRecords.push(artifactRecord);
        await options.artifactSink?.(artifactRecord);
      }
      return {
        result,
        artifactInfo: {
          runId: prepared.runId,
          matchId: result.state.id,
          ...(options.includeArtifacts && artifactRecord ? { artifact: artifactRecord.artifact } : {})
        }
      };
    },
    statusOf: (execution) => execution.result.status
  });

  for (const record of control.episodes) {
    if (record.prepared && record.result) {
      const episode = summarizeEpisode(
        record.index,
        record.seed,
        record.result.result,
        record.prepared.agents,
        assignment,
        record.prepared.resolvedAssignments,
        record.result.artifactInfo,
        jointPhaseScheduler
      );
      episodes.push(episode);
      if (episode.status === "completed") accumulateCompletedEpisode(modelStats, profileStats, episode);
      continue;
    }

    const prepared = record.prepared;
    const initialState = prepared?.initialState;
    const agents = prepared?.agents ?? [];
    episodes.push({
      index: record.index,
      seed: record.seed,
      ...(prepared ? { runId: prepared.runId, matchId: prepared.initialState.id } : {}),
      status: "failed",
      jointPhaseScheduler,
      assignment,
      resolvedAssignments: prepared?.resolvedAssignments ?? [],
      agents: (initialState?.players ?? []).map((player) => ({
        playerId: player.id,
        seat: player.seat,
        role: player.role,
        team: player.team,
        profileId: agents.find((agent) => agent.playerId === player.id)?.profileId,
        model: agents.find((agent) => agent.playerId === player.id)?.model ?? "unknown"
      })),
      error: record.error ?? "Tournament episode failed before producing a harness result."
    });
  }

  return {
    experiment,
    seed: options.seed,
    models,
    profiles,
    gamesRequested: options.games,
    gamesCompleted: control.gamesCompleted,
    gamesFailed: control.gamesFailed,
    gamesTruncated: control.gamesTruncated,
    gamesUnstarted: control.gamesUnstarted,
    maxTransitions: options.maxTransitions,
    assignment,
    episodes,
    modelStats,
    profileStats,
    artifacts: options.includeArtifacts ? artifactRecords : undefined
  };
}

interface DurableWerewolfEpisodeResult {
  result: HarnessRunResult;
  agents: HarnessAgentConfig[];
  resolvedAssignments: ResolvedAgentAssignment[];
  runId: string;
}

async function runDurableTournament(options: TournamentOptions): Promise<TournamentResult> {
  const orchestration = options.orchestration!;
  const defaultTemperature = options.temperature ?? 0.7;
  const profiles = options.profiles?.length ? options.profiles : profilesFromModels(options.models, defaultTemperature);
  const assignment = options.assignment ?? { strategy: "profile-rotation" as const };
  if (profiles.length === 0) throw new Error("Tournament requires at least one Agent profile or model.");
  if (!Number.isInteger(options.games) || options.games <= 0) throw new Error("Tournament games must be a positive integer.");
  const models = Array.from(new Set(profiles.map((profile) => profile.model)));
  assertRuntimeModelsAvailable(models, "Tournament");
  const jointPhaseScheduler = resolveJointPhaseScheduler(options);
  const experiment = buildEffectiveExperiment(options, { models, profiles, assignment, temperature: defaultTemperature });
  const genericSpec = buildWerewolfGenericExperimentSpec({
    options,
    experiment,
    profiles,
    assignment,
    defaultTemperature,
    jointPhaseScheduler
  });
  const runSetId = orchestration.runSetId ?? experiment.id;
  const execution = await runGenericExperiment({
    spec: genericSpec,
    runSetId,
    artifactStore: orchestration.artifactStore,
    runStore: orchestration.runStore,
    abortSignal: options.executionLimits?.abortSignal,
    adapter: {
      domainId: "werewolf",
      prepareEpisode(context) {
        const runId = durableWerewolfRunId(experiment.id, context.specHash, context.index);
        const initialState = createGame({ id: runId, seed: context.seed, config: options.config });
        const agents = resolveAgentConfigs(initialState.players, profiles, context.index, defaultTemperature, assignment);
        return {
          initialState,
          agents,
          resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
          runId
        };
      },
      async runEpisode(prepared): Promise<DurableWerewolfEpisodeResult> {
        const result = await runHarnessMatch({
          initialState: prepared.initialState,
          agents: prepared.agents,
          reasoner: options.reasoner,
          maxTransitions: options.maxTransitions,
          executionLimits: options.executionLimits,
          jointPhaseScheduler
        });
        return {
          result,
          agents: prepared.agents,
          resolvedAssignments: prepared.resolvedAssignments,
          runId: prepared.runId
        };
      },
      lifecycleOf: (episode) => episode.result.status,
      artifactForEpisode(episode, context) {
        return buildMatchArtifact({
          runId: episode.runId,
          matchId: episode.result.state.id,
          seed: context.seed,
          models,
          profiles,
          assignment,
          resolvedAssignments: episode.resolvedAssignments,
          result: episode.result
        });
      },
      assignmentResolutionForEpisode(episode) {
        return episode.resolvedAssignments.map((assignment) => {
          if (!assignment.profileId) {
            throw new Error(`Werewolf assignment resolution is missing profileId for actor ${assignment.playerId}.`);
          }
          return {
            actorId: assignment.playerId,
            profileId: assignment.profileId,
            model: assignment.model,
            seat: assignment.seat,
            ...(assignment.role === undefined ? {} : { role: assignment.role }),
            ...(assignment.team === undefined ? {} : { team: assignment.team }),
            ...(assignment.policyName === undefined ? {} : { domain: { policyName: assignment.policyName } })
          };
        });
      },
      checkpointing: {
        finalCheckpointForArtifact(artifact) {
          return buildFinalHarnessCheckpoint({
            artifact,
            checkpointId: `${artifact.runId}:checkpoint:native:${artifact.socialEpisode.steps.length}`,
            createdAt: artifact.createdAt,
            reason: "experiment checkpointPolicy final"
          });
        },
        nativeCheckpointForArtifactBoundary(artifact, boundary) {
          return buildHarnessCheckpointAtPrefix({
            artifact,
            selector: { nativeStepCount: boundary.nativeStepCount },
            checkpointId: `${artifact.runId}:checkpoint:native:${boundary.nativeStepCount}`,
            createdAt: artifact.createdAt,
            reason: "experiment checkpointPolicy native-boundaries"
          });
        }
      },
      evaluation: {
        reportForEpisode: (episode) => episode.result.evaluationReport
      }
    }
  });

  const episodes = execution.runSet.episodes.map((record): TournamentEpisode => {
    if (!record.artifact) {
      return {
        index: record.index,
        seed: record.seed,
        status: "failed",
        jointPhaseScheduler,
        assignment,
        resolvedAssignments: [],
        agents: [],
        error: record.error ?? "Tournament episode failed before producing a harness result."
      };
    }
    return summarizeArtifactEpisode(
      record.index,
      record.seed,
      record.artifact,
      assignment,
      jointPhaseScheduler,
      options.includeArtifacts ?? false
    );
  });
  const modelStats = initializeModelStats(models);
  const profileStats = initializeProfileStats(profiles);
  for (const episode of episodes) {
    if (episode.status === "completed") accumulateCompletedEpisode(modelStats, profileStats, episode);
  }
  const artifacts = options.includeArtifacts
    ? execution.runSet.episodes.flatMap((record) => record.artifact ? [{
        index: record.index,
        seed: record.seed,
        runId: record.artifact.runId,
        matchId: record.artifact.matchId,
        artifact: structuredClone(record.artifact)
      }] : [])
    : undefined;
  if (options.artifactSink) {
    for (const record of execution.runSet.episodes) {
      if (!record.artifact) continue;
      await options.artifactSink({
        index: record.index,
        seed: record.seed,
        runId: record.artifact.runId,
        matchId: record.artifact.matchId,
        artifact: structuredClone(record.artifact)
      });
    }
  }
  return {
    experiment,
    seed: options.seed,
    models,
    profiles,
    gamesRequested: execution.runSet.gamesRequested,
    gamesCompleted: execution.runSet.gamesCompleted,
    gamesFailed: execution.runSet.gamesFailed,
    gamesTruncated: execution.runSet.gamesTruncated,
    gamesUnstarted: execution.runSet.gamesUnstarted,
    maxTransitions: options.maxTransitions,
    assignment,
    episodes,
    modelStats,
    profileStats,
    artifacts
  };
}

function buildWerewolfGenericExperimentSpec(input: {
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

function portableJsonObject(value: unknown): GenericJsonObject {
  return JSON.parse(JSON.stringify(value)) as GenericJsonObject;
}

function durableWerewolfRunId(experimentId: string, specHash: string, index: number): string {
  const safeExperimentId = sanitizeId(experimentId).slice(0, 72) || "tournament";
  return `${safeExperimentId}-${specHash.slice(0, 12)}-g${index + 1}`;
}

function summarizeArtifactEpisode(
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
    jointPhaseScheduler: resolveJointPhaseScheduler(options),
    timeoutMs: options.experiment?.timeoutMs,
    temperature: runtime.temperature,
    json: options.experiment?.json ?? "summary",
    continueOnError: options.continueOnError ?? false,
    config: options.config
  };
}

function resolveJointPhaseScheduler(options: TournamentOptions): WerewolfJointPhaseScheduler {
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
  },
  jointPhaseScheduler?: WerewolfJointPhaseScheduler
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
    status: result.status,
    harnessStatus: result.status,
    jointPhaseScheduler,
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

  accumulateSocialStepDensity(modelStats, profileStats, episode);
}

function accumulateSocialStepDensity(
  modelStats: Record<string, TournamentModelStats>,
  profileStats: Record<string, TournamentProfileStats>,
  episode: TournamentEpisode
): void {
  const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
  const profileByPlayer = new Map(
    episode.agents
      .filter((agent): agent is typeof agent & { profileId: string } => Boolean(agent.profileId))
      .map((agent) => [agent.playerId, agent.profileId])
  );
  const steps = episode.socialEpisode?.steps ?? [];
  const densityByActor = countSocialStepCommitsByActor(steps);
  for (const [actorId, density] of densityByActor) {
    const modelName = modelByPlayer.get(actorId);
    if (!modelName) continue;
    const model = modelStats[modelName] ??= createEmptyStats(modelName);
    model.nativeSteps += density.nativeSteps;
    model.committedSteps += density.committedSteps;
    model.rejectedSteps += density.rejectedSteps;
  }
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const profileId = step.profileId || profileByPlayer.get(step.actorId);
    if (!profileId) continue;
    const profile =
      profileStats[profileId] ??=
        createEmptyProfileStats({
          id: profileId,
          model: modelByPlayer.get(step.actorId) ?? "unknown"
        });
    profile.nativeSteps += 1;
    if (isSocialStepCommitted(step)) profile.committedSteps += 1;
    else profile.rejectedSteps += 1;
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
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
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
