import { writeFile } from "node:fs/promises";
import { modelClientFromEnv, providerDiagnosticSummaryFromEnv } from "../agents/providerRegistry";
import { assertRuntimeModelsAvailable, normalizeModelList } from "../agents/schema";
import { createGame } from "../core/engine";
import type { MatchMetrics } from "../core/types";
import { assertValidMatchArtifactIntegrity, buildMatchArtifact, toTrajectoryJsonl } from "../harness/artifacts";
import { harnessFailureEvidenceFromEpisode } from "../harness/executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../harness/werewolfExecutionEvidence";
import { safeProviderFailureMessage } from "../harness/providerFailure";
import {
  legacyMetricPromotionPolicyFromSummary,
  summarizeEvaluationWarnings,
  summarizeResearchMetricPromotionRows
} from "../harness/evaluation";
import {
  assignmentFromUnknown,
  describeResolvedAssignments,
  profilesFromUnknown,
  resolveAgentConfigs,
  type HarnessAssignmentConfig
} from "../harness/profiles";
import { OpenAIHarnessReasoner } from "../harness/reasoner";
import { runHarnessMatch } from "../harness/runtime";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../harness/social";
import {
  summarizeTournamentMetricPromotionsFromMetrics
} from "../harness/tournamentArtifacts";
import type { AdversarialEvaluation, HarnessAgentProfile, HarnessEvaluationReport } from "../harness/types";

interface MatchOptions {
  models: string[];
  profiles: HarnessAgentProfile[];
  seed: string;
  temperature: number;
  assignment?: HarnessAssignmentConfig;
  timeoutMs?: number;
  maxTransitions?: number;
  export?: string;
  exportJsonl?: string;
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
            kind: "match",
            ok: false,
            provider: providerDiagnosticSummaryFromEnv(),
            evaluation: null,
            failureReason: safeProviderFailureMessage(error, "Match failed before the harness episode could start.")
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
  const options = parseOptions();
  const timeoutController = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => timeoutController.abort(new Error(`Match timeout exceeded ${options.timeoutMs}ms.`)), options.timeoutMs)
    : undefined;
  const startedAt = performance.now();
  const heartbeat = setInterval(() => {
    console.error(
      `[match] still waiting on real API calls, elapsedMs=${Math.round(performance.now() - startedAt)} maxTransitions=${
        options.maxTransitions ?? "none"
      }`
    );
  }, 15_000);
  heartbeat.unref();
  timeout?.unref();

  console.error(
    `[match] protocol=${providerDiagnosticSummaryFromEnv().protocol ?? "invalid"} configured=${providerDiagnosticSummaryFromEnv().configured} models=${options.models.join(",")} seed=${options.seed} timeoutMs=${
      options.timeoutMs ?? "none"
    } maxTransitions=${options.maxTransitions ?? "none"}`
  );

  try {
    const initialState = createGame({ id: `cli-${options.seed}`, seed: options.seed });
    const agents = resolveAgentConfigs(initialState.players, options.profiles, 0, options.temperature, options.assignment);
    const resolvedAssignments = describeResolvedAssignments(initialState.players, agents);

    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: OpenAIHarnessReasoner.forLiveProvider(
        modelClientFromEnv(process.env, {
          abortSignal: timeoutController.signal
        })
      ),
      maxTransitions: options.maxTransitions,
      executionLimits: { abortSignal: timeoutController.signal }
    });
    const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);
    const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);

    const summary = {
      kind: "match",
      ok:
        result.status === "completed" &&
        result.state.phase === "game_over" &&
        result.metrics.harnessErrorCount === 0,
      provider: providerDiagnosticSummaryFromEnv(),
      seed: options.seed,
      models: options.models,
      profiles: options.profiles,
      assignment: options.assignment ?? { strategy: "profile-rotation" },
      resolvedAssignments,
      status: result.status,
      truncationReason: result.truncationReason ?? null,
      failureStateHash: result.failureStateHash ?? null,
      elapsedMs: Math.round(performance.now() - startedAt),
      maxTransitions: options.maxTransitions ?? null,
      timeoutMs: options.timeoutMs ?? null,
      gameOver: result.state.phase === "game_over",
      stoppedBeforeGameOver: result.state.phase !== "game_over",
      winner: result.state.winner ?? null,
      endReason: result.state.endReason ?? null,
      day: result.state.day,
      phase: result.state.phase,
      harnessTurns: result.metrics.harnessTurnCount,
      harnessErrors: result.metrics.harnessErrorCount,
      ...countSocialStepCommits(result.socialEpisode.steps),
      trajectorySteps: result.trajectory.length,
      averageModelLatencyMs: result.metrics.averageLatencyMs,
      modelUsage: summarizeModelUsage(result.metrics),
      evaluation: summarizeEvaluation(result.evaluation, result.socialEpisode.steps),
      evaluationReport: summarizeEvaluationReport(result.evaluationReport),
      lastHarnessTurns: harnessTurns.slice(-12).map(summarizeHarnessTurn),
      harnessFailures: harnessErrors.map(summarizeHarnessFailure),
      failureReason:
        result.status === "failed"
          ? "Harness match failed; inspect validated failure records."
          : result.status === "truncated" || result.state.phase !== "game_over"
            ? "Harness match stopped before game_over; the artifact is retained for diagnosis but is not a completed live run."
          : harnessErrors.length
            ? "Harness recorded one or more failures; inspect validated failure records."
            : null,
      metrics: result.metrics,
      exports: {
        artifact: options.export ?? null,
        jsonl: options.exportJsonl ?? null
      },
      agents: (() => {
        const densityByActor = countSocialStepCommitsByActor(result.socialEpisode.steps);
        return result.agents.map((agent) => {
          const density = densityByActor.get(agent.playerId) ?? {
            nativeSteps: 0,
            committedSteps: 0,
            rejectedSteps: 0
          };
          return {
            playerId: agent.playerId,
            profileId: agent.profileId,
            model: agent.model,
            temperature: agent.temperature,
            policyName: agent.policyName,
            turns: agent.turns,
            observations: agent.observations,
            nativeSteps: density.nativeSteps,
            committedSteps: density.committedSteps,
            rejectedSteps: density.rejectedSteps
          };
        });
      })()
    };
    const artifact = buildMatchArtifact({
      runId: `cli-${options.seed}`,
      seed: options.seed,
      models: Array.from(new Set(options.profiles.map((profile) => profile.model))),
      profiles: options.profiles,
      assignment: options.assignment,
      resolvedAssignments,
      result
    });
    // CLI artifacts are an artifact-plane authority just like server-persisted
    // artifacts. Validate before any file write or full JSON emission.
    assertValidMatchArtifactIntegrity(artifact);

    if (options.export) {
      await writeFile(options.export, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    }
    if (options.exportJsonl) {
      await writeFile(options.exportJsonl, toTrajectoryJsonl(artifact), "utf8");
    }
    if (result.status !== "completed" || result.state.phase !== "game_over" || result.metrics.harnessErrorCount > 0) {
      process.exitCode = 1;
    }

    console.log(
      JSON.stringify(
        options.json === "full"
          ? {
              summary,
              artifact
            }
          : { summary },
        null,
        2
      )
    );
  } catch (error) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          summary: {
            kind: "match",
            ok: false,
            provider: providerDiagnosticSummaryFromEnv(),
            seed: options.seed,
            models: options.models,
            profiles: options.profiles,
            assignment: options.assignment ?? null,
            elapsedMs: Math.round(performance.now() - startedAt),
            maxTransitions: options.maxTransitions ?? null,
            timeoutMs: options.timeoutMs ?? null,
            timedOut: timeoutController.signal.aborted,
            evaluation: null,
            failureReason: summarizeMatchFailure(error, timeoutController.signal)
          }
        },
        null,
        2
      )
    );
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

function parseOptions(): MatchOptions {
  const json = readArg("json") ?? "summary";
  if (json !== "summary" && json !== "full") {
    throw new Error("--json must be summary or full.");
  }
  const temperature = parseTemperature(readArg("temperature") ?? process.env.AGENT_TEMPERATURE ?? "0.7");
  const models = normalizeModelList(readArg("models") ?? process.env.LLM_MODELS);
  const profiles = profilesFromUnknown(readArg("profiles") ?? process.env.AGENT_PROFILES, models, temperature);
  assertRuntimeModelsAvailable(profiles.map((profile) => profile.model), "Match");
  return {
    models,
    profiles,
    assignment: assignmentFromUnknown(readArg("assignment") ?? process.env.AGENT_ASSIGNMENT),
    seed: readArg("seed") ?? `cli-${Date.now()}`,
    temperature,
    timeoutMs: parseDurationMs(readArg("timeoutMs") ?? readArg("timeout") ?? process.env.MATCH_TIMEOUT_MS, "match timeout"),
    maxTransitions: parseOptionalPositiveInteger(
      readArg("maxTransitions") ?? readArg("steps") ?? process.env.MATCH_MAX_TRANSITIONS,
      "maxTransitions"
    ),
    export: readArg("export"),
    exportJsonl: readArg("exportJsonl"),
    json
  };
}

function summarizeModelUsage(metrics: MatchMetrics): Record<string, object> {
  return Object.fromEntries(
    Object.entries(metrics.modelUsage).map(([model, usage]) => [
      model,
      {
        calls: usage.calls,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalLatencyMs: usage.latencyMs,
        averageLatencyMs: usage.calls ? Math.round(usage.latencyMs / usage.calls) : 0
      }
    ])
  );
}

function summarizeEvaluation(
  evaluation: AdversarialEvaluation | undefined,
  socialSteps: Parameters<typeof countSocialStepCommits>[0] = []
): object | null {
  if (!evaluation) return null;
  return {
    winner: evaluation.winner ?? null,
    teamRewards: evaluation.teamRewards,
    agentRewards: evaluation.agentRewards.map((reward) => ({
      playerId: reward.playerId,
      profileId: reward.profileId,
      model: reward.model,
      role: reward.role,
      team: reward.team,
      won: reward.won,
      reward: reward.reward,
      components: reward.components
    })),
    voteAccuracyByAgent: evaluation.voteAccuracyByAgent,
    influenceByAgent: evaluation.influenceByAgent,
    deceptionByAgent: evaluation.deceptionByAgent,
    trajectorySteps: evaluation.trajectory.length,
    ...countSocialStepCommits(socialSteps),
    lastTrajectorySteps: evaluation.trajectory.slice(-12)
  };
}

function summarizeEvaluationReport(report: HarnessEvaluationReport | undefined): object | null {
  if (!report) return null;
  const promotionPolicy = legacyMetricPromotionPolicyFromSummary(report.summary.promotion);
  const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(report.metrics ?? [], promotionPolicy);
  return {
    id: report.id,
    evaluatorIds: report.evaluatorIds,
    metricCount: report.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    ...summarizeEvaluationWarnings(report.warnings),
    summary: report.summary,
    topMetrics: summarizeResearchMetricPromotionRows(report.metrics, 12, promotionPolicy)
  };
}

function summarizeHarnessTurn(event: ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>[number]): object {
  const trace = event.trace;
  return {
    seq: event.turnIndex,
    harnessTurn: trace.traceId,
    actorId: trace.playerId ?? event.actorId ?? null,
    model: trace.model ?? null,
    actionKind: trace.actionKind ?? null,
    policy: trace.policyName ?? null,
    command: trace.commandType ?? null,
    intent: trace.intent ?? null,
    targetId: trace.targetId ?? null,
    confidence: trace.confidence ?? null,
    modelLatencyMs: trace.latencyMs ?? null,
    promptTokens: trace.promptTokens ?? null,
    completionTokens: trace.completionTokens ?? null,
    stream: trace.stream
      ? {
          enabled: trace.stream.enabled,
          completed: trace.stream.completed,
          completedBy: trace.stream.completedBy ?? null
        }
      : null
  };
}

function summarizeHarnessFailure(event: ReturnType<typeof harnessFailureEvidenceFromEpisode>[number]): { failureReason: string } & Record<string, unknown> {
  const payload = event.payload ?? (isRecord(event.failure.metadata) ? event.failure.metadata : {});
  return {
    seq: event.turnIndex,
    actorId: event.actorId ?? null,
    failureStage: event.failure.stage,
    model: typeof payload.model === "string" ? payload.model : null,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : null,
    failureReason: `Harness step failed during ${event.failure.stage}.`
  };
}

function readArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`) || process.argv.slice(2).includes(`-${name[0]}`);
}

function parseDurationMs(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`${name} must be a duration like 30000, 30s, or 2m.`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * multiplier;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${name} must resolve to a positive integer number of milliseconds.`);
  return ms;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseTemperature(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new Error("temperature must be between 0 and 2.");
  return parsed;
}

function summarizeMatchFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "Match timeout or abort signal was triggered.";
  return safeProviderFailureMessage(error, "Match failed before the harness episode completed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run arena:match -- [--models=modelA,modelB] [--seed=name] [--maxTransitions=8] [--timeout=60s] [--json=summary|full]",
      "       npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35",
      "       npm run arena:match -- --assignment='{\"strategy\":\"team\",\"teams\":{\"werewolves\":[\"wolf\"],\"village\":[\"village\"]},\"fallback\":\"error\"}'",
      "       npm run arena:match -- --export=artifacts/match.json --exportJsonl=artifacts/trajectory.jsonl",
      "",
      "Runs a real multi-agent harness episode. No fake fallback or model substitution is used.",
      "Use --maxTransitions for short validation runs against real APIs."
    ].join("\n")
  );
}
