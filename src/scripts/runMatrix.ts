import { readFile } from "node:fs/promises";
import path from "node:path";
import { modelClientFromEnv, providerDiagnosticSummaryFromEnv } from "../agents/providerRegistry";
import type { TournamentExperimentSpecV1 } from "../harness/experiment";
import {
  mergeMatrixExperimentOverrides,
  normalizeMatrixExperimentSpec,
  runExperimentMatrix,
  writeExperimentMatrixArtifactDirectory,
  type ExperimentMatrixArtifactWriteResult,
  type ExperimentMatrixResult,
  type NormalizedMatrixExperiment
} from "../harness/experimentMatrix";
import { safeProviderFailureMessage } from "../harness/providerFailure";
import { OpenAIHarnessReasoner } from "../harness/reasoner";

interface MatrixCliOptions {
  experiment: NormalizedMatrixExperiment;
  outputDir?: string;
  overwrite: boolean;
  json: "summary" | "full";
  timeoutMs?: number;
}

if (hasFlag("help")) {
  printUsage();
} else {
  await main().catch((error) => {
    console.log(
      JSON.stringify(
        {
          summary: {
            kind: "experiment-matrix",
            ok: false,
            provider: providerDiagnosticSummaryFromEnv(),
            failureReason: safeProviderFailureMessage(error, "Experiment matrix failed before the harness run could start.")
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
    ? setTimeout(() => abortController.abort(new Error(`Matrix timeout exceeded ${options.timeoutMs}ms.`)), options.timeoutMs)
    : undefined;
  const heartbeat = setInterval(() => {
    console.error(
      `[matrix] still running real API calls, elapsedMs=${Math.round(performance.now() - startedAt)} cells=${options.experiment.cells.length} timeoutMs=${
        options.timeoutMs ?? "none"
      }`
    );
  }, 15_000);
  heartbeat.unref();
  timeout?.unref();

  const provider = providerDiagnosticSummaryFromEnv();
  console.error(
    `[matrix] protocol=${provider.protocol ?? "invalid"} configured=${provider.configured} matrix=${options.experiment.id} cells=${
      options.experiment.cells.length
    } timeoutMs=${options.timeoutMs ?? "none"}`
  );

  try {
    const result = await runExperimentMatrix({
      experiment: options.experiment,
      reasoner: OpenAIHarnessReasoner.forLiveProvider(modelClientFromEnv(process.env, { abortSignal: abortController.signal })),
      executionLimits: { abortSignal: abortController.signal },
      includeArtifacts: Boolean(options.outputDir),
      orchestrationBaseDirectory: path.resolve(process.env.EXPERIMENT_RUN_BASE_DIR ?? ".artifacts/experiment-runs")
    });
    const artifacts = options.outputDir
      ? await writeExperimentMatrixArtifactDirectory(result, {
          outputDir: options.outputDir,
          overwrite: options.overwrite
        })
      : undefined;
    const summary = buildMatrixSummary(result, {
      elapsedMs: Math.round(performance.now() - startedAt),
      timedOut: abortController.signal.aborted,
      timeoutMs: options.timeoutMs,
      artifacts
    });
    console.log(JSON.stringify(options.json === "full" ? { summary, result } : { summary }, null, 2));
    if (result.status !== "completed") process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

async function parseOptions(): Promise<MatrixCliOptions> {
  const spec = await readSpecInput(readArg("spec") ?? readArg("experiment"));
  const defaults: Partial<TournamentExperimentSpecV1> = {
    models: process.env.LLM_MODELS,
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT as TournamentExperimentSpecV1["assignment"],
    games: process.env.TOURNAMENT_GAMES,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
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
    timeout: readArg("timeoutMs") ?? readArg("timeout"),
    temperature: readArg("temperature"),
    json: readArg("json") as TournamentExperimentSpecV1["json"] | undefined,
    continueOnError: parseOptionalBoolean(readArg("continueOnError"), "continueOnError"),
    config: readJsonArg("config") as TournamentExperimentSpecV1["config"] | undefined
  }) as Partial<TournamentExperimentSpecV1>;
  const merged = mergeMatrixExperimentOverrides(spec, overrides);
  const experiment = normalizeMatrixExperimentSpec(merged, defaults);
  return {
    experiment,
    outputDir: readArg("outputDir") ?? readArg("exportDir"),
    overwrite: parseOptionalBoolean(readArg("overwrite"), "overwrite") ?? hasFlag("overwrite"),
    json: parseJsonMode(readArg("json")),
    timeoutMs: matrixTimeoutMs(experiment)
  };
}

function buildMatrixSummary(
  result: ExperimentMatrixResult,
  options: {
    elapsedMs: number;
    timedOut: boolean;
    timeoutMs?: number;
    artifacts?: ExperimentMatrixArtifactWriteResult;
  }
): object {
  return {
    kind: "experiment-matrix",
    ok: result.status === "completed",
    provider: providerDiagnosticSummaryFromEnv(),
    matrixId: result.experiment.id,
    status: result.status,
    cellsRequested: result.cellsRequested,
    cellsUnstarted: result.cellsUnstarted,
    cellsCompleted: result.cellsCompleted,
    cellsTruncated: result.cellsTruncated,
    cellsFailed: result.cellsFailed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesTruncated: result.gamesTruncated,
    gamesFailed: result.gamesFailed,
    gamesUnstarted: result.gamesUnstarted,
    timeoutMs: options.timeoutMs ?? null,
    elapsedMs: options.elapsedMs,
    timedOut: options.timedOut,
    denominatorPolicy: result.statistics.denominatorPolicy,
    modelStats: result.statistics.modelStats,
    profileStats: result.statistics.profileStats,
    pairwiseModelComparisons: result.statistics.pairwiseModelComparisons,
    cells: result.cells.map((cell) => ({
      index: cell.index,
      id: cell.id,
      label: cell.label,
      group: cell.group,
      status: cell.status,
      elapsedMs: cell.elapsedMs,
      gamesRequested: cell.tournament?.gamesRequested ?? 0,
      gamesCompleted: cell.tournament?.gamesCompleted ?? 0,
      gamesTruncated: cell.tournament?.gamesTruncated ?? cell.tournament?.episodes.filter((episode) => episode.status === "truncated").length ?? 0,
      gamesFailed: cell.tournament?.gamesFailed ?? 0,
      gamesUnstarted: cell.tournament?.gamesUnstarted ?? Math.max(0, (cell.tournament?.gamesRequested ?? 0) - (cell.tournament?.episodes.length ?? 0)),
      models: cell.tournament?.models ?? [],
      error: cell.error ?? null
    })),
    artifacts: options.artifacts ? summarizeArtifactWrite(options.artifacts) : null
  };
}

function summarizeArtifactWrite(artifacts: ExperimentMatrixArtifactWriteResult): object {
  return {
    outputDir: artifacts.outputDir,
    files: artifacts.files
  };
}

function matrixTimeoutMs(experiment: NormalizedMatrixExperiment): number | undefined {
  const timeouts = experiment.cells.map((cell) => cell.tournament.timeoutMs);
  if (timeouts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return undefined;
  return (timeouts as number[]).reduce((sum, value) => sum + value, 0);
}

async function readSpecInput(filePath: string | undefined): Promise<unknown> {
  if (!filePath) return undefined;
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function readJsonArg(name: string): unknown {
  const value = readArg(name);
  if (value === undefined || value.trim() === "") return undefined;
  return JSON.parse(value) as unknown;
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

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function parseJsonMode(value: string | undefined): "summary" | "full" {
  if (value === undefined || value.trim() === "") return "summary";
  if (value === "summary" || value === "full") return value;
  throw new Error("--json must be summary or full.");
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run arena:matrix -- --spec=experiments/matrix-smoke.json --outputDir=/tmp/werewolf-matrix",
      "       npm run arena:matrix -- --models=model-a,model-b --games=1 --maxTransitions=1 --timeout=5m",
      "",
      "Runs a matrix of tournament cells through the real harness/provider path.",
      "Live calls use the configured streaming provider adapter; no fake fallback or model substitution is used.",
      "Use --outputDir or --exportDir to write manifest.json, cells.jsonl, statistics.json, CSV files, summary.md, and nested tournament artifact directories.",
      "Existing artifact files are not overwritten unless --overwrite=true or --overwrite is provided."
    ].join("\n")
  );
}
