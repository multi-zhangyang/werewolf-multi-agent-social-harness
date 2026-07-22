import { readFile } from "node:fs/promises";
import { modelClientFromEnv, providerDiagnosticSummaryFromEnv } from "../agents/providerRegistry";
import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  type NormalizedTournamentExperiment,
  type TournamentExperimentSpecV1
} from "../harness/experiment";
import {
  legacyMetricPromotionPolicyFromSummary,
  summarizeEvaluationWarnings,
  summarizeResearchMetricPromotionRows
} from "../harness/evaluation";
import type { HarnessAssignmentConfig } from "../harness/profiles";
import { OpenAIHarnessReasoner } from "../harness/reasoner";
import { safeProviderFailureMessage } from "../harness/providerFailure";
import { runTournament } from "../harness/tournament";
import {
  summarizeTournamentMetricPromotionsFromMetrics,
  summarizeTournamentMetricPromotionsFromReports,
  summarizeTournamentExecutionTelemetry,
  writeTournamentArtifactDirectory,
  type ResearchTournamentArtifactFiles,
  type TournamentArtifactWriteResult
} from "../harness/tournamentArtifacts";
import { countSocialStepCommits } from "../harness/social";
import {
  averageTeamRewards,
  summarizeModelRewardsWithDensity,
  summarizeProfileRewardsWithDensity
} from "../harness/tournamentEvaluationSummary";
import type { AdversarialEvaluation, HarnessAgentProfile, HarnessEvaluationReport } from "../harness/types";

interface TournamentCliOptions {
  experiment: NormalizedTournamentExperiment;
  models: string[];
  profiles: HarnessAgentProfile[];
  experimentId: string;
  seed: string;
  games: number;
  temperature: number;
  assignment?: HarnessAssignmentConfig;
  maxTransitions?: number;
  jointPhaseScheduler?: TournamentExperimentSpecV1["jointPhaseScheduler"];
  timeoutMs?: number;
  continueOnError: boolean;
  config?: TournamentExperimentSpecV1["config"];
  outputDir?: string;
  overwrite: boolean;
  json: "summary" | "full";
}

if (hasFlag("help")) {
  printUsage();
} else {
  await main().catch((error) => {
    console.log(
      JSON.stringify(
        {
          summary: {
            kind: "tournament",
            ok: false,
            provider: providerDiagnosticSummaryFromEnv(),
            evaluation: null,
            failureReason: safeProviderFailureMessage(error, "Tournament failed before episodes could start.")
          }
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = await parseOptions();
  const startedAt = performance.now();
  const abortController = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Tournament timeout exceeded ${options.timeoutMs}ms.`)), options.timeoutMs)
    : undefined;
  const heartbeat = setInterval(() => {
    console.error(
      `[tournament] still running real API calls, elapsedMs=${Math.round(performance.now() - startedAt)} games=${options.games} maxTransitions=${
        options.maxTransitions ?? "none"
      }`
    );
  }, 15_000);
  heartbeat.unref();
  timeout?.unref();

  console.error(
    `[tournament] protocol=${providerDiagnosticSummaryFromEnv().protocol ?? "invalid"} configured=${providerDiagnosticSummaryFromEnv().configured} models=${options.models.join(",")} seed=${options.seed} games=${
      options.games
    } timeoutMs=${options.timeoutMs ?? "none"} maxTransitions=${options.maxTransitions ?? "none"}`
  );

  try {
    const result = await runTournament({
      models: options.models,
      profiles: options.profiles,
      assignment: options.assignment,
      seed: options.seed,
      games: options.games,
      maxTransitions: options.maxTransitions,
      jointPhaseScheduler: options.jointPhaseScheduler,
      config: options.config,
      temperature: options.temperature,
      experiment: options.experiment,
      reasoner: new OpenAIHarnessReasoner(modelClientFromEnv(process.env, { abortSignal: abortController.signal })),
      executionLimits: { abortSignal: abortController.signal },
      continueOnError: options.continueOnError,
      includeArtifacts: Boolean(options.outputDir)
    });
    const artifacts = options.outputDir
      ? await writeTournamentArtifactDirectory(result, {
          outputDir: options.outputDir,
          experimentId: options.experimentId,
          overwrite: options.overwrite
        })
      : undefined;
    const episodeStepTotals = result.episodes.reduce(
      (totals, episode) => {
        const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
        totals.nativeSteps += stepCounts.nativeSteps;
        totals.committedSteps += stepCounts.committedSteps;
        totals.rejectedSteps += stepCounts.rejectedSteps;
        return totals;
      },
      { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
    );
    const summary = {
      kind: "tournament",
      ok: result.gamesFailed === 0 && (result.gamesUnstarted ?? 0) === 0,
      status:
        result.gamesFailed > 0
          ? "failed"
          : (result.gamesUnstarted ?? Math.max(0, result.gamesRequested - result.episodes.length)) > 0
            ? "partial"
            : (result.gamesTruncated ?? 0) > 0
              ? "truncated"
              : "completed",
      provider: providerDiagnosticSummaryFromEnv(),
      experimentId: options.experimentId,
      seed: options.seed,
      models: result.models,
      profiles: result.profiles,
      assignment: result.assignment ?? null,
      gamesRequested: result.gamesRequested,
      gamesCompleted: result.gamesCompleted,
      gamesFailed: result.gamesFailed,
      gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
      gamesUnstarted: result.gamesUnstarted ?? Math.max(0, result.gamesRequested - result.episodes.length),
      maxTransitions: options.maxTransitions ?? null,
      jointPhaseScheduler: options.jointPhaseScheduler ?? "aec-batched-decision",
      timeoutMs: options.timeoutMs ?? null,
      continueOnError: options.continueOnError,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...episodeStepTotals,
      modelStats: result.modelStats,
      profileStats: result.profileStats,
      executionTelemetry: summarizeTournamentExecutionTelemetry(result),
      evaluation: summarizeTournamentEvaluation(result.episodes),
      evaluationReports: summarizeTournamentEvaluationReports(result.episodes),
      artifacts: artifacts ? summarizeArtifactWrite(artifacts) : null,
      failures: result.episodes
        .filter((episode) => episode.status === "failed")
        .map((episode) => ({
          index: episode.index,
          seed: episode.seed,
          failureReason: "Episode failed; inspect validated failure records."
        }))
    };
    console.log(JSON.stringify(options.json === "full" ? { summary, episodes: result.episodes } : { summary }, null, 2));
    if (result.gamesFailed > 0 || (result.gamesUnstarted ?? 0) > 0) process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

async function parseOptions(): Promise<TournamentCliOptions> {
  const spec = await readSpecInput(readArg("spec") ?? readArg("experiment"));
  const defaults: Partial<TournamentExperimentSpecV1> = {
    models: process.env.LLM_MODELS,
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT as TournamentExperimentSpecV1["assignment"],
    games: process.env.TOURNAMENT_GAMES,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
    jointPhaseScheduler: process.env.WEREWOLF_JOINT_PHASE_SCHEDULER as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? "0.7"
  };
  const overrides = removeUndefined({
    models: readArg("models"),
    profiles: readArg("profiles"),
    assignment: readArg("assignment") as TournamentExperimentSpecV1["assignment"] | undefined,
    seed: readArg("seed"),
    games: readArg("games"),
    maxTransitions: readArg("maxTransitions") ?? readArg("steps"),
    jointPhaseScheduler: readArg("jointPhaseScheduler") as TournamentExperimentSpecV1["jointPhaseScheduler"] | undefined,
    timeout: readArg("timeoutMs") ?? readArg("timeout"),
    temperature: readArg("temperature"),
    outputDir: readArg("outputDir") ?? readArg("exportDir"),
    overwrite: parseOptionalBoolean(readArg("overwrite"), "overwrite") ?? (hasFlag("overwrite") ? true : undefined),
    json: readArg("json") as TournamentExperimentSpecV1["json"] | undefined,
    continueOnError: parseOptionalBoolean(readArg("continueOnError"), "continueOnError")
  });
  const normalized = normalizeTournamentExperimentSpec(mergeExperimentOverrides(spec, overrides), defaults);
  return {
    experiment: normalized,
    models: normalized.models,
    profiles: normalized.profiles,
    experimentId: normalized.id,
    assignment: normalized.assignment,
    seed: normalized.seed,
    games: normalized.games,
    temperature: normalized.temperature,
    maxTransitions: normalized.maxTransitions,
    jointPhaseScheduler: normalized.jointPhaseScheduler,
    timeoutMs: normalized.timeoutMs,
    continueOnError: normalized.continueOnError,
    config: normalized.config,
    outputDir: typeof overrides.outputDir === "string" ? overrides.outputDir : undefined,
    overwrite: typeof overrides.overwrite === "boolean" ? overrides.overwrite : false,
    json: normalized.json
  };
}

type TournamentEpisodes = Awaited<ReturnType<typeof runTournament>>["episodes"];
type TournamentEpisode = TournamentEpisodes[number];

function summarizeTournamentEvaluation(episodes: TournamentEpisodes): object {
  const completed = episodes.filter((episode) => episode.status === "completed");
  const evaluated = completed.flatMap((episode) => {
    const evaluation = getEpisodeEvaluation(episode);
    return evaluation ? [{ episode, evaluation }] : [];
  });
  const evaluations = evaluated.map((item) => item.evaluation);
  const stepTotals = episodes.reduce(
    (totals, episode) => {
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const promotionSummary = summarizeTournamentMetricPromotionsFromReports(
    episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []))
  );
  const reports = episodes.flatMap((episode) => {
    const report = (episode as TournamentEpisode & { evaluationReport?: unknown }).evaluationReport;
    return isEvaluationReport(report) ? [report] : [];
  });

  return {
    gamesEvaluated: evaluated.length,
    gamesWithoutEvaluation: completed.length - evaluated.length,
    evaluationCompletedEpisodes: reports.filter((report) => (report.status ?? "completed") === "completed").length,
    evaluationIncompleteEpisodes: reports.filter((report) => (report.status ?? "completed") === "incomplete").length,
    evaluatorFailureCount: reports.reduce((sum, report) => sum + (report.failures?.length ?? 0), 0),
    teamRewards: averageTeamRewards(evaluations),
    modelRewards: summarizeModelRewardsWithDensity(evaluated),
    profileRewards: summarizeProfileRewardsWithDensity(evaluated),
    nativeSteps: stepTotals.nativeSteps,
    committedSteps: stepTotals.committedSteps,
    rejectedSteps: stepTotals.rejectedSteps,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    episodes: evaluated.map(({ episode, evaluation }) => {
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
      const episodePromotion = summarizeTournamentMetricPromotionsFromMetrics(
        episode.evaluationReport?.metrics ?? [],
        legacyMetricPromotionPolicyFromSummary(episode.evaluationReport?.summary.promotion)
      );
      return {
        index: episode.index,
        seed: episode.seed,
        winner: evaluation.winner ?? episode.winner ?? null,
        teamRewards: evaluation.teamRewards,
        agentRewards: evaluation.agentRewards.map(summarizeAgentReward),
        trajectorySteps: evaluation.trajectory.length,
        metricCount: episode.evaluationReport?.metricCount ?? episodePromotion.metricCount,
        scorecardEligibleMetricCount: episodePromotion.scorecardEligibleCount,
        metricPromotionClassCounts: episodePromotion.byClass,
        scorecardEligibleMetricClassCounts: episodePromotion.scorecardEligibleByClass,
        ...stepCounts
      };
    })
  };
}

function summarizeTournamentEvaluationReports(episodes: TournamentEpisodes): object {
  const reports = episodes.flatMap((episode) => {
    const report = (episode as TournamentEpisode & { evaluationReport?: unknown }).evaluationReport;
    return isEvaluationReport(report) ? [report] : [];
  });
  const warningSummary = summarizeEvaluationWarnings(reports.flatMap((report) => report.warnings ?? []));
  const promotionSummary = summarizeTournamentMetricPromotionsFromReports(reports);
  return {
    reports: reports.length,
    completedReports: reports.filter((report) => (report.status ?? "completed") === "completed").length,
    incompleteReports: reports.filter((report) => (report.status ?? "completed") === "incomplete").length,
    evaluatorFailureCount: reports.reduce((sum, report) => sum + (report.failures?.length ?? 0), 0),
    metricCount: reports.reduce((sum, report) => sum + report.metricCount, 0),
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    ...warningSummary,
    reportsWithWarnings: reports.filter((report) => (report.warnings?.length ?? 0) > 0).length,
    evaluatorIds: Array.from(new Set(reports.flatMap((report) => report.evaluatorIds))),
    episodeScores: reports.map((report) => report.summary.episodeScore ?? null),
    // Research CLI only: redacted public server path must not expose topMetrics.
    topMetrics: summarizeResearchMetricPromotionRowsFromReports(reports, 24),
    episodeReports: reports.map((report) => {
      const episodePromotion = summarizeTournamentMetricPromotionsFromMetrics(
        report.metrics ?? [],
        legacyMetricPromotionPolicyFromSummary(report.summary.promotion)
      );
      return {
        id: report.id,
        status: report.status ?? "completed",
        evaluatorFailureCount: report.failures?.length ?? 0,
        evaluatorIds: report.evaluatorIds,
        metricCount: report.metricCount,
        scorecardEligibleMetricCount: episodePromotion.scorecardEligibleCount,
        metricPromotionClassCounts: episodePromotion.byClass,
        scorecardEligibleMetricClassCounts: episodePromotion.scorecardEligibleByClass,
        episodeScore: report.summary.episodeScore ?? null
      };
    })
  };
}

function summarizeResearchMetricPromotionRowsFromReports(reports: readonly HarnessEvaluationReport[], limit: number) {
  const rows = reports.flatMap((report) =>
    summarizeResearchMetricPromotionRows(
      report.metrics ?? [],
      Math.max(1, report.metrics.length),
      legacyMetricPromotionPolicyFromSummary(report.summary.promotion)
    )
  );
  return rows.slice(0, Math.max(0, limit));
}

function summarizeArtifactWrite(artifacts: TournamentArtifactWriteResult<ResearchTournamentArtifactFiles>): object {
  return {
    outputDir: artifacts.outputDir,
    files: {
      manifest: artifacts.files.manifest,
      registry: artifacts.files.registry,
      specNormalized: artifacts.files.specNormalized,
      assignment: artifacts.files.assignment,
      episodes: artifacts.files.episodes,
      trajectory: artifacts.files.trajectory,
      metrics: artifacts.files.metrics,
      integrity: artifacts.files.integrity,
      failures: artifacts.files.failures,
      costLatency: artifacts.files.costLatency,
      leaderboard: artifacts.files.leaderboard,
      benchmarkStatistics: artifacts.files.benchmarkStatistics,
      summaryMarkdown: artifacts.files.summaryMarkdown,
      episodesCsv: artifacts.files.episodesCsv,
      agentsCsv: artifacts.files.agentsCsv,
      metricsCsv: artifacts.files.metricsCsv,
      leaderboardCsv: artifacts.files.leaderboardCsv,
      matchesDir: artifacts.files.matchesDir,
      matches: artifacts.files.matches,
      matchesJsonl: artifacts.files.matchesJsonl
    }
  };
}

function isEvaluationReport(value: unknown): value is HarnessEvaluationReport {
  return isRecord(value) && Array.isArray(value.evaluatorIds) && Array.isArray(value.metrics) && isRecord(value.summary);
}

function getEpisodeEvaluation(episode: TournamentEpisode): AdversarialEvaluation | undefined {
  const evaluation = (episode as TournamentEpisode & { evaluation?: unknown }).evaluation;
  return isAdversarialEvaluation(evaluation) ? evaluation : undefined;
}

function isAdversarialEvaluation(value: unknown): value is AdversarialEvaluation {
  return (
    isRecord(value) &&
    isRecord(value.teamRewards) &&
    Array.isArray(value.agentRewards) &&
    Array.isArray(value.trajectory) &&
    isRecord(value.voteAccuracyByAgent) &&
    isRecord(value.influenceByAgent) &&
    isRecord(value.deceptionByAgent)
  );
}


function summarizeAgentReward(reward: AdversarialEvaluation["agentRewards"][number]): object {
  return {
    playerId: reward.playerId,
    profileId: reward.profileId,
    model: reward.model,
    role: reward.role,
    team: reward.team,
    won: reward.won,
    reward: reward.reward,
    components: reward.components
  };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`) || process.argv.slice(2).includes(`-${name[0]}`);
}

async function readSpecInput(path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run arena:tournament -- [--models=modelA,modelB] [--games=3] [--seed=name] [--maxTransitions=8] [--timeout=5m] [--json=summary|full]",
      "       npm run arena:tournament -- --spec=experiments/wolf-vs-village.json",
      "       npm run arena:tournament -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35",
      "       npm run arena:tournament -- --assignment='{\"strategy\":\"role\",\"roles\":{\"werewolf\":[\"wolf\"],\"seer\":\"seer\"},\"fallback\":\"profile-rotation\"}'",
      "       npm run arena:tournament -- --games=1 --maxTransitions=0 --outputDir=/tmp/werewolf-tournament-artifacts",
      "",
      "Runs role-balanced multi-agent harness episodes. No fake fallback or model substitution is used.",
      "Use --outputDir or --exportDir to write manifest.json, registry.json, JSONL files, CSV analysis files, summary.md, leaderboard.json, benchmark_statistics.json, and per-match artifacts.",
      "Existing artifact files are not overwritten unless --overwrite=true or --overwrite is provided."
    ].join("\n")
  );
}
