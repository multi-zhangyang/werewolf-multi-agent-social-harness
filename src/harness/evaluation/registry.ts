import { AgentHarnessState, HarnessEvaluationModuleResult, HarnessEvaluationReport, HarnessEvaluatorFailure, HarnessEvaluatorManifestConfig, HarnessEvaluatorManifestEntry, HarnessMetricRecord, HarnessStepRecord } from "../types";
import { DEFAULT_METRIC_PROMOTION_POLICY, MetricPromotionPolicy, createMetricPromotionPolicy, isNonEmptyString, materializeMetricPromotion } from "./metricPromotion";
import { collectEvaluationWarnings, summarizeMetrics, uniqueStrings } from "./metricSummary";
export type HarnessEvaluationStatus = "completed" | "truncated" | "failed";

/**
 * Domain-neutral evaluator input. A domain selects its own durable actor
 * snapshot and trajectory contracts; evaluators must not require a Werewolf
 * PlayerView, GameCommand, or legacy HarnessStepRecord unless they are
 * explicitly domain-owned evaluators.
 */
export interface HarnessEvaluationContext<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
> {
  id: string;
  status: HarnessEvaluationStatus;
  initialState: TState;
  finalState: TState;
  agents: TAgent[];
  trajectory: TTrajectory[];
  metrics?: TMetrics;
  socialEpisode?: TSocialEpisode;
}

export interface HarnessEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TOutput = unknown,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
> {
  id: string;
  label: string;
  version: string;
  manifest?: HarnessEvaluatorManifestConfig;
  evaluate(context: HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>): HarnessEvaluationModuleResult<TOutput>;
}

interface EvaluatorManifestSource {
  id: string;
  label: string;
  version: string;
  manifest?: HarnessEvaluatorManifestConfig;
}

export interface EvaluationModuleRun {
  evaluator: EvaluatorManifestSource;
  result: HarnessEvaluationModuleResult;
  metrics: HarnessMetricRecord[];
  manifest: HarnessEvaluatorManifestEntry;
}

const EVALUATOR_EXECUTION_FAILURE_MESSAGE = "Evaluator execution failed; no metrics or output were recorded.";
const EVALUATOR_INVALID_RESULT_MESSAGE = "Evaluator returned an invalid module result; no metrics or output were recorded.";

export function runEvaluationRegistry<
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
>(options: {
  id: string;
  context: HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>;
  evaluators: Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>;
  createdAt?: string;
  promotionPolicy?: MetricPromotionPolicy;
}): HarnessEvaluationReport {
  // Evaluation inputs are recorded harness truth, not evaluator-owned working
  // memory. Reject non-portable/cyclic values up front so every module can be
  // given an independent immutable snapshot with deterministic clone semantics.
  assertStrictJsonData(options.context);
  const canonicalContext = cloneFrozenEvaluationContext(options.context);
  const promotionPolicy = createMetricPromotionPolicy(
    options.promotionPolicy ?? DEFAULT_METRIC_PROMOTION_POLICY
  );
  const moduleResults: Array<{
    evaluator: EvaluatorManifestSource;
    result: HarnessEvaluationModuleResult;
    metrics: HarnessMetricRecord[];
    manifest: HarnessEvaluatorManifestEntry;
  }> = [];
  const evaluatorRegistry: HarnessEvaluatorManifestEntry[] = [];
  const failures: HarnessEvaluatorFailure[] = [];

  for (const evaluator of options.evaluators) {
    let evaluatorSource: EvaluatorManifestSource;
    try {
      evaluatorSource = cloneEvaluatorManifestSource(evaluator);
    } catch {
      const fallback = evaluatorIdentitySource(evaluator);
      failures.push(evaluatorFailure(fallback, "result_normalization"));
      evaluatorRegistry.push(evaluatorManifestEntry(fallback, evaluatorFallbackModuleResult(fallback), []));
      continue;
    }
    let rawResult: HarnessEvaluationModuleResult;
    try {
      // Every module still receives its own frozen context identity, but the
      // deep-frozen canonical snapshot is shared instead of re-running a
      // structuredClone of the full episode per evaluator: the freeze is what
      // enforces isolation, so a fresh top-level wrapper preserves the
      // independent-snapshot contract at a fraction of the cost.
      rawResult = evaluator.evaluate(Object.freeze({ ...canonicalContext }));
    } catch {
      failures.push(evaluatorFailure(evaluatorSource, "evaluate"));
      evaluatorRegistry.push(evaluatorManifestEntry(evaluatorSource, evaluatorFallbackModuleResult(evaluatorSource), []));
      continue;
    }

    try {
      // A module may return a reference also reachable through plugin closure
      // state. Detach it immediately so a later evaluator cannot retroactively
      // rewrite an earlier module's evidence or manifest.
      const result = structuredClone(rawResult);
      assertEvaluationModuleResult(result);
      const metrics = result.metrics.map((item) => {
        if (!isPlainRecord(item)) throw new Error("invalid evaluator metric");
        return materializeMetricPromotion(
          {
            ...item,
            evaluatorId: item.evaluatorId ?? result.evaluatorId,
            evaluatorVersion: item.evaluatorVersion ?? result.version,
            evidenceRefs: item.evidenceRefs ?? []
          },
          promotionPolicy
        );
      });
      const manifest = evaluatorManifestEntry(evaluatorSource, result, metrics);
      evaluatorRegistry.push(manifest);
      moduleResults.push({ evaluator: evaluatorSource, result, metrics, manifest });
    } catch {
      failures.push(evaluatorFailure(evaluatorSource, "result_normalization"));
      evaluatorRegistry.push(evaluatorManifestEntry(evaluatorSource, evaluatorFallbackModuleResult(evaluatorSource), []));
    }
  }
  const metrics = moduleResults.flatMap((moduleResult) => moduleResult.metrics);
  const moduleRuns: EvaluationModuleRun[] = moduleResults;
  const report: HarnessEvaluationReport = {
    id: options.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    status: failures.length ? "incomplete" : "completed",
    failures,
    evaluatorIds: moduleResults.map(({ result }) => result.evaluatorId),
    evaluatorRegistry,
    metricCount: metrics.length,
    metrics,
    outputs: Object.fromEntries(moduleResults.map(({ result }) => [result.evaluatorId, result.output ?? null])),
    warnings: collectEvaluationWarnings(moduleRuns, promotionPolicy),
    summary: summarizeMetrics(metrics, promotionPolicy)
  };
  const normalizedReport: HarnessEvaluationReport = {
    ...report,
    metrics: report.metrics.map(normalizeMetricNumericFields)
  };
  // Invalid top-level numeric metric fields have already contributed explicit
  // diagnostics and are normalized above. Any remaining non-JSON value is a
  // registry bug, not something JSON.stringify may silently coerce.
  assertStrictJsonData(normalizedReport);
  return JSON.parse(JSON.stringify(normalizedReport)) as HarnessEvaluationReport;
}

function cloneFrozenEvaluationContext<
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent,
  TTrajectory
>(
  context: HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>
): HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory> {
  return deepFreezeEvaluationValue(structuredClone(context));
}

function deepFreezeEvaluationValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeEvaluationValue(child);
  }
  return Object.freeze(value);
}

function evaluatorIdentitySource(evaluator: EvaluatorManifestSource): EvaluatorManifestSource {
  return { id: evaluator.id, label: evaluator.label, version: evaluator.version };
}

function cloneEvaluatorManifestSource(evaluator: EvaluatorManifestSource): EvaluatorManifestSource {
  const identity = evaluatorIdentitySource(evaluator);
  if (evaluator.manifest === undefined) return identity;
  assertStrictJsonData(evaluator.manifest);
  return { ...identity, manifest: structuredClone(evaluator.manifest) };
}

function evaluatorFallbackModuleResult(evaluator: EvaluatorManifestSource): HarnessEvaluationModuleResult {
  return {
    evaluatorId: evaluator.id,
    label: evaluator.label,
    version: evaluator.version,
    metrics: []
  };
}

function evaluatorFailure(evaluator: EvaluatorManifestSource, stage: HarnessEvaluatorFailure["stage"]): HarnessEvaluatorFailure {
  return {
    evaluatorId: evaluator.id,
    label: evaluator.label,
    version: evaluator.version,
    stage,
    code: stage === "evaluate" ? "evaluator_exception" : "invalid_module_result",
    message: stage === "evaluate" ? EVALUATOR_EXECUTION_FAILURE_MESSAGE : EVALUATOR_INVALID_RESULT_MESSAGE
  };
}

function assertEvaluationModuleResult(value: unknown): asserts value is HarnessEvaluationModuleResult {
  if (!isPlainRecord(value)) throw new Error("invalid evaluator module result");
  if (!isNonEmptyString(value.evaluatorId) || !isNonEmptyString(value.label) || !isNonEmptyString(value.version)) {
    throw new Error("invalid evaluator module identity");
  }
  if (!Array.isArray(value.metrics)) throw new Error("invalid evaluator metrics");
  for (const metric of value.metrics) assertEvaluatorMetricData(metric);
  if (value.output !== undefined) assertStrictJsonData(value.output);
  if (value.manifest !== undefined) assertStrictJsonData(value.manifest);
}

function assertEvaluatorMetricData(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error("invalid evaluator metric object");
  const diagnosedNumericFields = new Set(["value", "weight", "denominator", "confidence"]);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    // Historical evaluator contracts diagnose these four fields after module
    // execution. Preserve that behavior while rejecting non-finite numbers in
    // metadata, subjects, evidence, and every other nested location.
    if (diagnosedNumericFields.has(key) && typeof item === "number") continue;
    assertStrictJsonData(item);
  }
}

function normalizeMetricNumericFields(metric: HarnessMetricRecord): HarnessMetricRecord {
  const normalized = { ...metric };
  if (typeof normalized.value === "number" && !Number.isFinite(normalized.value)) {
    normalized.value = null;
  }
  for (const field of ["weight", "denominator", "confidence"] as const) {
    if (typeof normalized[field] === "number" && !Number.isFinite(normalized[field])) {
      delete normalized[field];
    }
  }
  return normalized;
}

function assertStrictJsonData(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid non-finite evaluator data");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("invalid non-JSON evaluator data");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertStrictJsonData(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid evaluator object prototype");
    for (const item of Object.values(value as Record<string, unknown>)) {
      // Optional object properties are normalized away by the report builder;
      // array holes/undefined values still fail through the recursive branch.
      if (item === undefined) continue;
      assertStrictJsonData(item, seen);
    }
  }
  seen.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evaluatorManifestEntry(
  evaluator: EvaluatorManifestSource,
  result: HarnessEvaluationModuleResult,
  metrics: HarnessMetricRecord[]
): HarnessEvaluatorManifestEntry {
  const manifest = {
    ...(evaluator.manifest ?? {}),
    ...(result.manifest ?? {})
  };
  return {
    id: result.evaluatorId,
    label: result.label,
    version: result.version,
    inputSchema: manifest.inputSchema ?? "harness.evaluation.context.v1",
    outputSchema: manifest.outputSchema ?? "harness.evaluation.output.untyped.v1",
    mode: manifest.mode ?? "deterministic",
    metricIds: manifest.metricIds ? uniqueStrings(manifest.metricIds) : uniqueStrings(metrics.map((item) => item.id)),
    rubric: manifest.rubric,
    dependencies: manifest.dependencies ?? {},
    aggregation: manifest.aggregation ?? "weighted_summary",
    visibility: manifest.visibility ?? "postgame"
  };
}
