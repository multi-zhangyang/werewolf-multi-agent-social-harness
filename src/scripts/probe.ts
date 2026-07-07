import { modelClientFromEnv, providerConfigSummaryFromEnv } from "../agents/providerRegistry";
import { normalizeModelList } from "../agents/schema";
import { applyCommand, createGame, getPendingActions } from "../core/engine";
import { isAgentPendingAction } from "../core/pending";
import { OpenAIHarnessReasoner } from "../harness/reasoner";
import { probeHarnessTurn } from "../harness/runtime";

interface ProbeOptions {
  models: string[];
  timeoutMs?: number;
}

interface ProbeSummary {
  kind: "probe";
  ok: boolean;
  model: string;
  harnessTurn?: {
    traceId: string;
    day: number;
    phase: string;
    actorId: string;
    actionKind: string;
    policy: string;
    command: string;
    intent: string;
    confidence: number;
  };
  modelLatencyMs: number | null;
  promptTokens?: number;
  completionTokens?: number;
  providerRequestId?: string;
  elapsedMs: number;
  failureReason: string | null;
}

if (hasFlag("help")) {
  printUsage();
} else {
  await main().catch((error) => {
    console.log(
      JSON.stringify(
        {
          summary: {
            kind: "probe",
            ok: false,
            provider: providerConfigSummaryFromEnv(),
            endpoint: providerConfigSummaryFromEnv().endpoint,
            failureReason: describeError(error)
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
    ? setTimeout(() => timeoutController.abort(new Error(`Probe timeout exceeded ${options.timeoutMs}ms.`)), options.timeoutMs)
    : undefined;
  const heartbeat = setInterval(() => {
    console.error(`[probe] still waiting on real API calls, elapsedMs=${Math.round(performance.now() - startedAt)}`);
  }, 15_000);
  heartbeat.unref();
  timeout?.unref();

  const startedAt = performance.now();
  const reasoner = new OpenAIHarnessReasoner(
    modelClientFromEnv(process.env, {
      abortSignal: timeoutController.signal
    })
  );
  const results: ProbeSummary[] = [];

  console.error(
    `[probe] provider=${providerConfigSummaryFromEnv().protocol} endpoint=${providerConfigSummaryFromEnv().endpoint ?? "none"} models=${options.models.join(",")} timeoutMs=${options.timeoutMs ?? "none"}`
  );

  try {
    for (const model of options.models) {
      if (timeoutController.signal.aborted) {
        results.push({
          kind: "probe",
          ok: false,
          model,
          modelLatencyMs: null,
          elapsedMs: Math.round(performance.now() - startedAt),
          failureReason: abortReason(timeoutController.signal.reason)
        });
        process.exitCode = 1;
        continue;
      }

      const modelStarted = performance.now();
      console.error(`[probe] model=${model} starting harness turn`);
      try {
        let state = createGame({
          id: `probe-${model.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          seed: `probe-${model}`
        });
        while (getPendingActions(state).length === 1 && getPendingActions(state)[0].kind === "advance") {
          state = applyCommand(state, { type: "system.advance", actorId: "system" });
        }
        const action = getPendingActions(state).find(isAgentPendingAction);
        if (!action) {
          throw new Error(`No pending Agent action for ${model}.`);
        }
        const probe = await probeHarnessTurn({
          state,
          action,
          agent: {
            playerId: action.actorId,
            model,
            temperature: 0.2
          },
          reasoner
        });
        results.push({
          kind: "probe",
          ok: true,
          model,
          harnessTurn: {
            traceId: probe.trace.traceId,
            day: state.day,
            phase: state.phase,
            actorId: action.actorId,
            actionKind: action.kind,
            policy: probe.trace.policyName,
            command: probe.command.type,
            intent: probe.trace.intent,
            confidence: probe.trace.confidence
          },
          modelLatencyMs: probe.trace.latencyMs,
          promptTokens: probe.trace.promptTokens,
          completionTokens: probe.trace.completionTokens,
          providerRequestId: probe.trace.providerRequestId,
          elapsedMs: Math.round(performance.now() - modelStarted),
          failureReason: null
        });
      } catch (error) {
        process.exitCode = 1;
        results.push({
          kind: "probe",
          ok: false,
          model,
          modelLatencyMs: null,
          elapsedMs: Math.round(performance.now() - modelStarted),
          failureReason: describeError(error)
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    JSON.stringify(
      {
        summary: {
          kind: "probe",
          ok: failed.length === 0,
          provider: providerConfigSummaryFromEnv(),
          endpoint: providerConfigSummaryFromEnv().endpoint,
          models: options.models,
          timeoutMs: options.timeoutMs ?? null,
          elapsedMs: Math.round(performance.now() - startedAt),
          succeeded: results.length - failed.length,
          failed: failed.length,
          failureReason: failed.length ? failed.map((result) => `${result.model}: ${result.failureReason}`).join(" | ") : null
        },
        results
      },
      null,
      2
    )
  );
}

function parseOptions(): ProbeOptions {
  return {
    models: normalizeModelList(readArg("models") ?? process.env.LLM_MODELS),
    timeoutMs: parseDurationMs(readArg("timeoutMs") ?? readArg("timeout") ?? process.env.PROBE_TIMEOUT_MS, "probe timeout")
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return reason ? String(reason) : "Probe timeout or abort signal was triggered.";
}

function printUsage(): void {
  console.log(`Usage: npm run agent:probe -- [--models=modelA,modelB] [--timeout=30s]\n\nRuns one real OpenAI-compatible harness turn per model. No fake fallback or model substitution is used.`);
}
