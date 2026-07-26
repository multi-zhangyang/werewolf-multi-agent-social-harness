import path from "node:path";
import { createGame } from "../../core/engine";
import { assertRuntimeModelsAvailable } from "../../agents/schema";
import {
  describeResolvedAssignments,
  profilesFromModels,
  resolveAgentConfigs
} from "../profiles";
import {
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  validateHarnessCheckpoint,
  validateMatchArtifactIntegrity,
  type HarnessCheckpoint,
  type MatchArtifact
} from "../artifacts";
import { HarnessEpisodeArtifactStore } from "../episodeArtifactStore";
import { HarnessExperimentRunStore } from "../experimentRunStore";
import { runGenericExperiment } from "../experimentOrchestrator";
import { runHarnessMatch } from "../runtime";
import { runTournamentEpisodes } from "../tournamentRunner";
import type {
  DurableWerewolfEpisodeResult,
  OpenedTournamentOrchestrationOptions,
  TournamentEpisode,
  TournamentMatchArtifactRecord,
  TournamentOptions,
  TournamentResult,
  WerewolfTournamentExecution,
  WerewolfTournamentPreparedEpisode
} from "./types";
import {
  buildEffectiveExperiment,
  buildWerewolfGenericExperimentSpec,
  durableWerewolfRunId,
  resolveJointPhaseScheduler,
  summarizeArtifactEpisode
} from "./spec";
import {
  accumulateCompletedEpisode,
  initializeModelStats,
  initializeProfileStats,
  sanitizeId,
  summarizeEpisode
} from "./stats";

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
