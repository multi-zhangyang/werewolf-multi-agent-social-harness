import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RoomCheckpoint } from "../persistence";
import type { SocialCausalityState, StrategyProfileSnapshot } from "../social/contracts";
import type {
  CrossPlayEvaluation,
  CrossPlayPlan,
  CrossPlayRun,
  CrossPlayRunSpec,
  EvaluationStoreState,
  FrozenOpponentPool,
  MetaStrategySelection,
  OpponentPoolEntry
} from "./contracts";

const EVALUATION_STORE_SCHEMA_VERSION = 4;

export class SocialTruthStore {
  private readonly state: EvaluationStoreState;

  constructor(private readonly file = path.resolve(process.cwd(), "data", "social-truth.json")) {
    this.state = readState(file);
  }

  snapshot(): EvaluationStoreState {
    return structuredClone(this.state);
  }

  freezeOpponentPool(checkpoints: RoomCheckpoint[]): FrozenOpponentPool {
    const snapshots = uniqueSnapshots(checkpoints);
    if (!snapshots.length) throw new Error("STRATEGY_PROFILES_MISSING: Selected rooms contain no strategy profile snapshots.");
    const createdAt = new Date().toISOString();
    const entries: OpponentPoolEntry[] = snapshots.map((snapshot) => ({
      entryId: `opponent-${snapshot.configurationHash.slice(0, 20)}`,
      strategyProfileSnapshotId: snapshot.strategyProfileSnapshotId,
      configurationHash: snapshot.configurationHash,
      status: "frozen",
      supportedScenarioIds: scenarioIdsFor(checkpoints, snapshot.strategyProfileSnapshotId),
      strategyProfileSnapshot: structuredClone(snapshot),
      addedAt: createdAt,
      provenance: {
        sourceKind: "system-inference",
        sourceIds: checkpoints.map((checkpoint) => `room:${checkpoint.roomId}`),
        confidence: 1,
        createdAtLogical: 0,
        schemaVersion: 1
      },
      schemaVersion: 1
    }));
    const configurationHash = hashJson(entries.map((entry) => ({
      strategyProfileSnapshotId: entry.strategyProfileSnapshotId,
      configurationHash: entry.configurationHash,
      supportedScenarioIds: entry.supportedScenarioIds
    })));
    const existing = this.state.opponentPools.find((pool) => pool.configurationHash === configurationHash);
    if (existing) {
      if (existing.entries.some((entry) => !entry.strategyProfileSnapshot)) {
        existing.entries = entries;
        existing.schemaVersion = 1;
        this.persist();
      }
      return structuredClone(existing);
    }
    const pool: FrozenOpponentPool = {
      opponentPoolVersion: `opponent-pool-${configurationHash.slice(0, 20)}`,
      entries,
      configurationHash,
      createdAt,
      schemaVersion: 1
    };
    this.state.opponentPools.push(pool);
    this.persist();
    return structuredClone(pool);
  }

  compileCrossPlayEvaluation(checkpoints: RoomCheckpoint[], opponentPoolVersion: string): CrossPlayEvaluation {
    const pool = this.state.opponentPools.find((entry) => entry.opponentPoolVersion === opponentPoolVersion);
    if (!pool) throw new Error(`OPPONENT_POOL_NOT_FOUND: '${opponentPoolVersion}'.`);
    if (!checkpoints.length) throw new Error("CROSS_PLAY_RUNS_REQUIRED: Select at least one archived room.");
    const runs = checkpoints.map((checkpoint) => compileRun(checkpoint));
    const evaluation = buildEvaluation(runs, pool);
    const existing = this.state.evaluations.find((entry) => entry.evaluationId === evaluation.evaluationId);
    if (existing) return structuredClone(existing);
    this.state.evaluations.push(evaluation);
    this.persist();
    return structuredClone(evaluation);
  }

  opponentPool(opponentPoolVersion: string): FrozenOpponentPool | undefined {
    const pool = this.state.opponentPools.find((entry) => entry.opponentPoolVersion === opponentPoolVersion);
    return pool ? structuredClone(pool) : undefined;
  }

  saveCrossPlayPlan(plan: CrossPlayPlan): CrossPlayPlan {
    if (this.state.crossPlayPlans.some((entry) => entry.planId === plan.planId)) {
      throw new Error(`CROSS_PLAY_PLAN_EXISTS: '${plan.planId}'.`);
    }
    this.state.crossPlayPlans.push(structuredClone(plan));
    this.persist();
    return structuredClone(plan);
  }

  crossPlayPlan(planId: string): CrossPlayPlan | undefined {
    const plan = this.state.crossPlayPlans.find((entry) => entry.planId === planId);
    return plan ? structuredClone(plan) : undefined;
  }

  updateCrossPlayPlan(planId: string, update: (plan: CrossPlayPlan) => void): CrossPlayPlan {
    const plan = this.state.crossPlayPlans.find((entry) => entry.planId === planId);
    if (!plan) throw new Error(`CROSS_PLAY_PLAN_NOT_FOUND: '${planId}'.`);
    update(plan);
    plan.progress = progressFor(plan.runSpecs);
    this.persist();
    return structuredClone(plan);
  }

  compileCrossPlayPlanEvaluation(planId: string, checkpoints: RoomCheckpoint[]): CrossPlayEvaluation {
    const plan = this.state.crossPlayPlans.find((entry) => entry.planId === planId);
    if (!plan) throw new Error(`CROSS_PLAY_PLAN_NOT_FOUND: '${planId}'.`);
    const pool = this.state.opponentPools.find((entry) => entry.opponentPoolVersion === plan.opponentPoolVersion);
    if (!pool) throw new Error(`OPPONENT_POOL_NOT_FOUND: '${plan.opponentPoolVersion}'.`);
    const checkpointsByRoom = new Map(checkpoints.map((checkpoint) => [checkpoint.roomId, checkpoint]));
    const runs = plan.runSpecs.map((spec) => {
      const checkpoint = checkpointsByRoom.get(spec.roomId);
      return checkpoint ? compileRun(checkpoint, plan, spec) : compileMissingRun(plan, spec);
    });
    const evaluation = buildEvaluation(runs, pool, plan.planId);
    const existing = this.state.evaluations.find((entry) => entry.evaluationId === evaluation.evaluationId);
    const stored = existing ?? evaluation;
    if (!existing) this.state.evaluations.push(evaluation);
    plan.evaluationId = stored.evaluationId;
    this.persist();
    return structuredClone(stored);
  }

  selectMetaStrategy(evaluationId: string, iterations: number): MetaStrategySelection {
    const evaluation = this.state.evaluations.find((entry) => entry.evaluationId === evaluationId);
    if (!evaluation) throw new Error(`CROSS_PLAY_EVALUATION_NOT_FOUND: '${evaluationId}'.`);
    if (!Number.isInteger(iterations) || iterations < 10 || iterations > 100_000) {
      throw new Error("META_STRATEGY_ITERATIONS_INVALID: iterations must be 10 to 100000.");
    }
    const selection = regretMatchingSelection(evaluation, iterations);
    const existing = this.state.metaStrategies.find((entry) => entry.metaStrategyId === selection.metaStrategyId);
    if (existing) return structuredClone(existing);
    this.state.metaStrategies.push(selection);
    this.persist();
    return structuredClone(selection);
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

function compileRun(
  checkpoint: RoomCheckpoint,
  plan?: CrossPlayPlan,
  spec?: CrossPlayRunSpec
): CrossPlayRun {
  const causality = socialState(checkpoint);
  const snapshots = causality?.strategyProfileSnapshots ?? [];
  const active = causality?.activeStrategyProfileSnapshotIds ?? {};
  const executedSeatBindings: Record<string, string> = {};
  const effectiveReasoningEffort: CrossPlayRun["effectiveReasoningEffort"] = {};
  for (const participant of checkpoint.snapshot.participants) {
    const snapshotId = active[participant.profile.id]
      ?? [...snapshots].reverse().find((entry) => entry.actorId === participant.profile.id)?.strategyProfileSnapshotId;
    if (!snapshotId) continue;
    executedSeatBindings[participant.profile.id] = snapshotId;
    const snapshot = snapshots.find((entry) => entry.strategyProfileSnapshotId === snapshotId);
    effectiveReasoningEffort[participant.profile.id] = requestedEffort(snapshot);
  }
  const downgradeNotices = checkpoint.envelopes.filter((entry) =>
    entry.event.type === "runtime.notice" && entry.event.category === "reasoning"
  );
  for (const envelope of downgradeNotices) {
    const event = envelope.event;
    if (event.type !== "runtime.notice" || !event.actorId || !event.effectiveEffort) continue;
    effectiveReasoningEffort[event.actorId] = event.effectiveEffort;
  }
  const providerFailures = checkpoint.envelopes.filter((entry) =>
    entry.event.type === "runtime.notice" && entry.event.category === "provider" && entry.event.severity === "error"
  );
  const reconciliations = causality?.outcomeReconciliations ?? [];
  const predictionAssessments = reconciliations.flatMap((entry) => entry.predictionAssessments);
  const calibrationBins = calibrationBinsFor(predictionAssessments);
  const decisions = causality?.decisions ?? [];
  const linkedDecisionIds = new Set((causality?.influenceLinks ?? []).flatMap((entry) => entry.decisionId ? [entry.decisionId] : []));
  const commitments = causality?.commitments ?? [];
  const deceptions = causality?.deceptions ?? [];
  const payoff = Object.fromEntries(checkpoint.snapshot.participants.map((participant) => [participant.profile.id, participant.score ?? 0]));
  const roleBindings = Object.fromEntries(checkpoint.snapshot.participants.map((participant) => [participant.profile.id, participant.role ?? "unknown"]));
  const completed = checkpoint.status === "finished";
  const seatBindings = spec ? structuredClone(spec.seatBindings) : executedSeatBindings;
  const planStatus = spec ? runStatusFor(spec.status) : undefined;
  const startedAt = spec?.startedAt ? Date.parse(spec.startedAt) : Number.NaN;
  const finishedAt = spec?.finishedAt ? Date.parse(spec.finishedAt) : Number.NaN;
  const wallTimeMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : 0;
  return {
    runId: `cross-play-run-${hashJson({ roomId: checkpoint.roomId, archivedAt: checkpoint.archivedAt }).slice(0, 20)}`,
    ...(plan ? { planId: plan.planId } : {}),
    ...(spec ? { runSpecId: spec.runSpecId } : {}),
    roomId: checkpoint.roomId,
    scenarioId: checkpoint.snapshot.scenarioId,
    status: planStatus ?? (completed ? (providerFailures.length ? "partial" : "completed") : "failed"),
    seatBindings,
    ...(spec ? { executedSeatBindings } : {}),
    roleBindings,
    effectiveReasoningEffort,
    downgradeEventIds: downgradeNotices.map((entry) => entry.id),
    payoff,
    archiveRef: `room:${checkpoint.roomId}`,
    ...(spec ? {
      usage: {
        agentActivations: spec.agentActivations,
        totalTokens: spec.totalTokens,
        wallTimeMs
      }
    } : {}),
    predictionCount: predictionAssessments.length,
    ...(predictionAssessments.length
      ? { brierScore: average(predictionAssessments.map((entry) => entry.squaredError)) }
      : {}),
    calibrationBins,
    socialCausality: {
      decisionCount: decisions.length,
      decisionsWithObservation: decisions.filter((entry) => entry.observationRefs.length > 0).length,
      decisionsWithEvidence: decisions.filter((entry) => entry.evidenceRefs.length > 0).length,
      decisionsWithOutcome: decisions.filter((entry) => Boolean(entry.outcomeReconciliationId)).length,
      influenceLinkedDecisions: decisions.filter((entry) => linkedDecisionIds.has(entry.decisionId)).length,
      commitmentCount: commitments.length,
      settledCommitmentCount: commitments.filter((entry) => entry.state === "fulfilled" || entry.state === "violated" || entry.state === "void").length,
      deceptionCount: deceptions.length,
      detectedDeceptionCount: deceptions.filter((entry) =>
        entry.status === "detected" || entry.status === "repair-attempted" || entry.status === "repaired"
      ).length,
      repairAttemptedDeceptionCount: deceptions.filter((entry) =>
        entry.status === "repair-attempted" || entry.status === "repaired"
      ).length,
      repairedDeceptionCount: deceptions.filter((entry) => entry.status === "repaired").length,
      deceptionAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.targetAudienceCharacterIds),
        0
      ),
      deceptionReceivedAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.receivedByCharacterIds),
        0
      ),
      deceptionBelievedAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.believedByCharacterIds),
        0
      ),
      deceptionRejectedAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.rejectedByCharacterIds),
        0
      ),
      deceptionDetectedAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.detectedByCharacterIds),
        0
      ),
      deceptionRepairAcceptedAudienceCount: deceptions.reduce(
        (sum, entry) => sum + uniqueCount(entry.repairAcceptedByCharacterIds),
        0
      ),
      shadowSelectionCount: (causality?.strategySelections ?? []).filter((entry) => Boolean(entry.shadowRecommendation)).length,
      shadowAgreementCount: (causality?.strategySelections ?? []).filter((entry) => entry.shadowRecommendation?.agreedWithAgent).length
    },
    failureCodes: [...new Set([
      ...providerFailures.map((entry) => entry.event.type === "runtime.notice" ? entry.event.code : "PROVIDER_TURN_FAILED"),
      ...(spec?.errorCode ? [spec.errorCode] : [])
    ])],
    createdAt: spec?.finishedAt ?? checkpoint.archivedAt,
    schemaVersion: 2
  };
}

function compileMissingRun(plan: CrossPlayPlan, spec: CrossPlayRunSpec): CrossPlayRun {
  const startedAt = spec.startedAt ? Date.parse(spec.startedAt) : Number.NaN;
  const finishedAt = spec.finishedAt ? Date.parse(spec.finishedAt) : Number.NaN;
  return {
    runId: `cross-play-run-${hashJson({ planId: plan.planId, runSpecId: spec.runSpecId }).slice(0, 20)}`,
    planId: plan.planId,
    runSpecId: spec.runSpecId,
    roomId: spec.roomId,
    scenarioId: spec.scenarioId,
    status: runStatusFor(spec.status),
    seatBindings: structuredClone(spec.seatBindings),
    roleBindings: structuredClone(spec.observedRoleBindings ?? {}),
    effectiveReasoningEffort: {},
    downgradeEventIds: [],
    payoff: {},
    predictionCount: 0,
    calibrationBins: calibrationBinsFor([]),
    usage: {
      agentActivations: spec.agentActivations,
      totalTokens: spec.totalTokens,
      wallTimeMs: Number.isFinite(startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, finishedAt - startedAt)
        : 0
    },
    socialCausality: {
      decisionCount: 0,
      decisionsWithObservation: 0,
      decisionsWithEvidence: 0,
      decisionsWithOutcome: 0,
      influenceLinkedDecisions: 0,
      commitmentCount: 0,
      settledCommitmentCount: 0,
      deceptionCount: 0,
      detectedDeceptionCount: 0,
      repairAttemptedDeceptionCount: 0,
      repairedDeceptionCount: 0,
      deceptionAudienceCount: 0,
      deceptionReceivedAudienceCount: 0,
      deceptionBelievedAudienceCount: 0,
      deceptionRejectedAudienceCount: 0,
      deceptionDetectedAudienceCount: 0,
      deceptionRepairAcceptedAudienceCount: 0,
      shadowSelectionCount: 0,
      shadowAgreementCount: 0
    },
    failureCodes: [spec.errorCode ?? missingRunFailureCode(spec.status)],
    createdAt: spec.finishedAt ?? spec.createdAt,
    schemaVersion: 2
  };
}

function buildEvaluation(runs: CrossPlayRun[], pool: FrozenOpponentPool, planId?: string): CrossPlayEvaluation {
  const profileOrder = [...new Set(runs.flatMap((run) => Object.values(run.seatBindings)))].sort();
  const scoresByProfileAndSeat = new Map<string, Map<string, number[]>>();
  const pairwisePayoffs = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status === "failed") continue;
    for (const [actorId, profileId] of Object.entries(run.seatBindings)) {
      if (!(actorId in run.payoff)) continue;
      const bySeat = scoresByProfileAndSeat.get(profileId) ?? new Map<string, number[]>();
      const values = bySeat.get(actorId) ?? [];
      values.push(run.payoff[actorId]);
      bySeat.set(actorId, values);
      scoresByProfileAndSeat.set(profileId, bySeat);
      for (const [opponentActorId, opponentProfileId] of Object.entries(run.seatBindings)) {
        if (opponentActorId === actorId || !(opponentActorId in run.payoff)) continue;
        const key = pairwiseKey(profileId, opponentProfileId);
        const samples = pairwisePayoffs.get(key) ?? [];
        samples.push(run.payoff[actorId] - run.payoff[opponentActorId]);
        pairwisePayoffs.set(key, samples);
      }
    }
  }
  const seatAdjustedScores = Object.fromEntries(profileOrder.map((profileId) => {
    const bySeat = scoresByProfileAndSeat.get(profileId);
    const equallyWeightedSeatMeans = bySeat ? [...bySeat.values()].map(average) : [];
    return [profileId, Number(average(equallyWeightedSeatMeans).toFixed(6))];
  }));
  const payoffMatrix = profileOrder.map((left) => profileOrder.map((right) => {
    if (left === right) return 0;
    return Number(average(pairwisePayoffs.get(pairwiseKey(left, right)) ?? []).toFixed(6));
  }));
  const payoffSampleCounts = profileOrder.map((left) => profileOrder.map((right) =>
    left === right ? 0 : (pairwisePayoffs.get(pairwiseKey(left, right))?.length ?? 0)
  ));
  const predictionCount = runs.reduce((sum, run) => sum + run.predictionCount, 0);
  const combinedBins = combineCalibrationBins(runs.flatMap((run) => run.calibrationBins));
  const totals = runs.reduce((accumulator, run) => {
    const metrics = run.socialCausality;
    accumulator.decisions += metrics.decisionCount;
    accumulator.observations += metrics.decisionsWithObservation;
    accumulator.evidence += metrics.decisionsWithEvidence;
    accumulator.outcomes += metrics.decisionsWithOutcome;
    accumulator.influence += metrics.influenceLinkedDecisions;
    accumulator.commitments += metrics.commitmentCount;
    accumulator.settledCommitments += metrics.settledCommitmentCount;
    accumulator.deceptions += metrics.deceptionCount;
    accumulator.detectedDeceptions += metrics.detectedDeceptionCount;
    accumulator.repairAttemptedDeceptions += metrics.repairAttemptedDeceptionCount;
    accumulator.repairedDeceptions += metrics.repairedDeceptionCount;
    accumulator.deceptionAudience += metrics.deceptionAudienceCount;
    accumulator.deceptionReceivedAudience += metrics.deceptionReceivedAudienceCount;
    accumulator.deceptionBelievedAudience += metrics.deceptionBelievedAudienceCount;
    accumulator.deceptionRejectedAudience += metrics.deceptionRejectedAudienceCount;
    accumulator.deceptionDetectedAudience += metrics.deceptionDetectedAudienceCount;
    accumulator.deceptionRepairAcceptedAudience += metrics.deceptionRepairAcceptedAudienceCount;
    accumulator.shadowSelections += metrics.shadowSelectionCount;
    accumulator.shadowAgreements += metrics.shadowAgreementCount;
    return accumulator;
  }, {
    decisions: 0,
    observations: 0,
    evidence: 0,
    outcomes: 0,
    influence: 0,
    commitments: 0,
    settledCommitments: 0,
    deceptions: 0,
    detectedDeceptions: 0,
    repairAttemptedDeceptions: 0,
    repairedDeceptions: 0,
    deceptionAudience: 0,
    deceptionReceivedAudience: 0,
    deceptionBelievedAudience: 0,
    deceptionRejectedAudience: 0,
    deceptionDetectedAudience: 0,
    deceptionRepairAcceptedAudience: 0,
    shadowSelections: 0,
    shadowAgreements: 0
  });
  const identity = {
    opponentPoolVersion: pool.opponentPoolVersion,
    ...(planId ? { planId } : {}),
    runIds: runs.map((run) => run.runId).sort()
  };
  return {
    evaluationId: `cross-play-${hashJson(identity).slice(0, 24)}`,
    scenarioIds: [...new Set(runs.map((run) => run.scenarioId))].sort(),
    strategyProfileSnapshotIds: profileOrder,
    opponentPoolVersion: pool.opponentPoolVersion,
    runs,
    aggregate: {
      payoffMatrix,
      payoffSampleCounts,
      profileOrder,
      seatAdjustedScores,
      ...(predictionCount ? {
        meanBrierScore: runs.reduce((sum, run) => sum + (run.brierScore ?? 0) * run.predictionCount, 0) / predictionCount
      } : {}),
      ...(predictionCount ? { expectedCalibrationError: expectedCalibrationError(combinedBins, predictionCount) } : {}),
      predictionCount,
      socialCausalityCoverage: {
        observation: ratio(totals.observations, totals.decisions),
        evidence: ratio(totals.evidence, totals.decisions),
        outcome: ratio(totals.outcomes, totals.decisions),
        influence: ratio(totals.influence, totals.decisions),
        commitmentSettlement: ratio(totals.settledCommitments, totals.commitments),
        deceptionDetection: totals.deceptions ? ratio(totals.detectedDeceptions, totals.deceptions) : null,
        deceptionRepairAttempt: totals.detectedDeceptions
          ? ratio(totals.repairAttemptedDeceptions, totals.detectedDeceptions)
          : null,
        deceptionRepair: totals.detectedDeceptions ? ratio(totals.repairedDeceptions, totals.detectedDeceptions) : null,
        deceptionDelivery: totals.deceptionAudience
          ? ratio(totals.deceptionReceivedAudience, totals.deceptionAudience)
          : null,
        deceptionBelief: totals.deceptionReceivedAudience
          ? ratio(totals.deceptionBelievedAudience, totals.deceptionReceivedAudience)
          : null,
        deceptionRejection: totals.deceptionReceivedAudience
          ? ratio(totals.deceptionRejectedAudience, totals.deceptionReceivedAudience)
          : null,
        deceptionAudienceDetection: totals.deceptionReceivedAudience
          ? ratio(totals.deceptionDetectedAudience, totals.deceptionReceivedAudience)
          : null,
        deceptionRepairAcceptance: totals.deceptionDetectedAudience
          ? ratio(totals.deceptionRepairAcceptedAudience, totals.deceptionDetectedAudience)
          : null,
        shadowAgreement: totals.shadowSelections ? ratio(totals.shadowAgreements, totals.shadowSelections) : null
      },
      reasoningDowngrades: runs.reduce((sum, run) => sum + run.downgradeEventIds.length, 0),
      providerFailures: runs.reduce(
        (sum, run) => sum + run.failureCodes.filter((code) => code.startsWith("PROVIDER_")).length,
        0
      ),
      completedRuns: runs.filter((run) => run.status === "completed").length,
      partialRuns: runs.filter((run) => run.status === "partial").length,
      failedRuns: runs.filter((run) => run.status === "failed").length
    },
    createdAt: new Date().toISOString(),
    schemaVersion: 2
  };
}

function uniqueSnapshots(checkpoints: RoomCheckpoint[]): StrategyProfileSnapshot[] {
  const result = new Map<string, StrategyProfileSnapshot>();
  for (const checkpoint of checkpoints) {
    for (const snapshot of socialState(checkpoint)?.strategyProfileSnapshots ?? []) {
      result.set(snapshot.strategyProfileSnapshotId, structuredClone(snapshot));
    }
  }
  return [...result.values()].sort((left, right) => left.strategyProfileSnapshotId.localeCompare(right.strategyProfileSnapshotId));
}

function scenarioIdsFor(checkpoints: RoomCheckpoint[], snapshotId: string): string[] {
  return [...new Set(checkpoints.flatMap((checkpoint) =>
    (socialState(checkpoint)?.strategyProfileSnapshots ?? []).some((entry) => entry.strategyProfileSnapshotId === snapshotId)
      ? [checkpoint.snapshot.scenarioId]
      : []
  ))].sort();
}

function socialState(checkpoint: RoomCheckpoint): SocialCausalityState | undefined {
  return checkpoint.worldState?.shared.socialCausality;
}

function requestedEffort(snapshot: StrategyProfileSnapshot | undefined): "xhigh" | "high" | "provider-default" {
  const value = snapshot?.reasoningFallback.requestedEffort;
  return value === "xhigh" || value === "high" ? value : "provider-default";
}

function calibrationBinsFor(
  assessments: Array<{ predictedProbability: number; actual: boolean }>
): CrossPlayRun["calibrationBins"] {
  return Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const values = assessments.filter((entry) =>
      entry.predictedProbability >= lower && (index === 9 ? entry.predictedProbability <= upper : entry.predictedProbability < upper)
    );
    return {
      lower,
      upper,
      count: values.length,
      meanPrediction: values.length ? average(values.map((entry) => entry.predictedProbability)) : 0,
      empiricalRate: values.length ? average(values.map((entry) => entry.actual ? 1 : 0)) : 0
    };
  });
}

function combineCalibrationBins(bins: CrossPlayRun["calibrationBins"]): CrossPlayRun["calibrationBins"] {
  return Array.from({ length: 10 }, (_, index) => {
    const values = bins.filter((entry) => entry.lower === index / 10);
    const count = values.reduce((sum, entry) => sum + entry.count, 0);
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      count,
      meanPrediction: count ? values.reduce((sum, entry) => sum + entry.meanPrediction * entry.count, 0) / count : 0,
      empiricalRate: count ? values.reduce((sum, entry) => sum + entry.empiricalRate * entry.count, 0) / count : 0
    };
  });
}

function expectedCalibrationError(bins: CrossPlayRun["calibrationBins"], predictionCount: number): number {
  return bins.reduce((sum, entry) =>
    sum + (entry.count / predictionCount) * Math.abs(entry.meanPrediction - entry.empiricalRate), 0
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}

function uniqueCount(values: string[]): number {
  return new Set(values).size;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pairwiseKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function regretMatchingSelection(evaluation: CrossPlayEvaluation, iterations: number): MetaStrategySelection {
  const profileOrder = evaluation.aggregate.profileOrder;
  const size = profileOrder.length;
  if (size < 2) throw new Error("META_STRATEGY_POPULATION_TOO_SMALL: At least two frozen profiles are required.");
  const sampleCounts = evaluation.aggregate.payoffSampleCounts;
  if (!sampleCounts || profileOrder.some((_left, leftIndex) =>
    profileOrder.some((_right, rightIndex) => leftIndex !== rightIndex && (sampleCounts[leftIndex]?.[rightIndex] ?? 0) < 1)
  )) {
    throw new Error("META_STRATEGY_PAYOFF_MATRIX_INCOMPLETE: Every ordered profile pair needs a real cross-play sample.");
  }
  const matrix = evaluation.aggregate.payoffMatrix;
  let strategy = Array.from({ length: size }, () => 1 / size);
  const cumulativeStrategy = Array.from({ length: size }, () => 0);
  const cumulativeRegret = Array.from({ length: size }, () => 0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < size; index += 1) cumulativeStrategy[index] += strategy[index];
    const actionPayoffs = matrix.map((row) => row.reduce(
      (sum, payoff, opponentIndex) => sum + payoff * strategy[opponentIndex],
      0
    ));
    const expected = strategy.reduce((sum, probability, index) => sum + probability * actionPayoffs[index], 0);
    for (let index = 0; index < size; index += 1) {
      cumulativeRegret[index] += actionPayoffs[index] - expected;
    }
    const positiveRegrets = cumulativeRegret.map((regret) => Math.max(0, regret));
    const totalPositiveRegret = positiveRegrets.reduce((sum, regret) => sum + regret, 0);
    strategy = totalPositiveRegret > 0
      ? positiveRegrets.map((regret) => regret / totalPositiveRegret)
      : Array.from({ length: size }, () => 1 / size);
  }
  const distributionValues = normalizeDistribution(cumulativeStrategy);
  const responsePayoffs = matrix.map((row) => row.reduce(
    (sum, payoff, opponentIndex) => sum + payoff * distributionValues[opponentIndex],
    0
  ));
  const expectedPayoff = distributionValues.reduce(
    (sum, probability, index) => sum + probability * responsePayoffs[index],
    0
  );
  const bestResponsePayoff = Math.max(...responsePayoffs);
  const bestResponseIndex = responsePayoffs.indexOf(bestResponsePayoff);
  const identity = {
    evaluationId: evaluation.evaluationId,
    iterations,
    profileOrder,
    payoffMatrix: matrix,
    payoffSampleCounts: sampleCounts
  };
  return {
    metaStrategyId: `meta-strategy-${hashJson(identity).slice(0, 24)}`,
    evaluationId: evaluation.evaluationId,
    opponentPoolVersion: evaluation.opponentPoolVersion,
    algorithm: "regret-matching",
    iterations,
    profileOrder: [...profileOrder],
    distribution: Object.fromEntries(profileOrder.map((profileId, index) => [
      profileId,
      Number(distributionValues[index].toFixed(8))
    ])),
    expectedPayoff: Number(expectedPayoff.toFixed(8)),
    ...(bestResponseIndex >= 0 ? {
      bestResponseProfileSnapshotId: profileOrder[bestResponseIndex],
      bestResponsePayoff: Number(bestResponsePayoff.toFixed(8)),
      exploitabilityProxy: Number(Math.max(0, bestResponsePayoff - expectedPayoff).toFixed(8))
    } : {}),
    createdAt: new Date().toISOString(),
    schemaVersion: 1
  };
}

function normalizeDistribution(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return Array.from({ length: values.length }, () => 1 / values.length);
  return values.map((value) => Math.max(0, value) / total);
}

function migrateEvaluation(evaluation: CrossPlayEvaluation): CrossPlayEvaluation {
  const runs = evaluation.runs.map((run): CrossPlayRun => ({
    ...run,
    socialCausality: {
      ...run.socialCausality,
      deceptionAudienceCount: run.socialCausality.deceptionAudienceCount ?? 0,
      deceptionReceivedAudienceCount: run.socialCausality.deceptionReceivedAudienceCount ?? 0,
      deceptionBelievedAudienceCount: run.socialCausality.deceptionBelievedAudienceCount ?? 0,
      deceptionRejectedAudienceCount: run.socialCausality.deceptionRejectedAudienceCount ?? 0,
      deceptionDetectedAudienceCount: run.socialCausality.deceptionDetectedAudienceCount ?? 0,
      deceptionRepairAcceptedAudienceCount: run.socialCausality.deceptionRepairAcceptedAudienceCount ?? 0
    },
    schemaVersion: 2
  }));
  const coverage = evaluation.aggregate.socialCausalityCoverage;
  return {
    ...evaluation,
    runs,
    aggregate: {
      ...evaluation.aggregate,
      socialCausalityCoverage: {
        ...coverage,
        deceptionDelivery: coverage.deceptionDelivery ?? null,
        deceptionBelief: coverage.deceptionBelief ?? null,
        deceptionRejection: coverage.deceptionRejection ?? null,
        deceptionAudienceDetection: coverage.deceptionAudienceDetection ?? null,
        deceptionRepairAcceptance: coverage.deceptionRepairAcceptance ?? null
      }
    },
    schemaVersion: 2
  };
}

function readState(file: string): EvaluationStoreState {
  if (!existsSync(file)) return {
    schemaVersion: EVALUATION_STORE_SCHEMA_VERSION,
    opponentPools: [],
    crossPlayPlans: [],
    evaluations: [],
    metaStrategies: []
  };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<EvaluationStoreState>;
    return {
      schemaVersion: EVALUATION_STORE_SCHEMA_VERSION,
      opponentPools: Array.isArray(parsed.opponentPools) ? parsed.opponentPools : [],
      crossPlayPlans: Array.isArray(parsed.crossPlayPlans)
        ? parsed.crossPlayPlans.map(interruptRunningPlan)
        : [],
      evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations.map(migrateEvaluation) : [],
      metaStrategies: Array.isArray(parsed.metaStrategies) ? parsed.metaStrategies : []
    };
  } catch {
    throw new Error("SOCIAL_TRUTH_STORE_CORRUPT: Evaluation store cannot be parsed.");
  }
}

function progressFor(runSpecs: CrossPlayRunSpec[]): CrossPlayPlan["progress"] {
  return {
    queuedRuns: runSpecs.filter((entry) => entry.status === "queued").length,
    runningRuns: runSpecs.filter((entry) => entry.status === "running").length,
    finishedRuns: runSpecs.filter((entry) => entry.status !== "queued" && entry.status !== "running").length,
    agentActivations: runSpecs.reduce((sum, entry) => sum + entry.agentActivations, 0),
    totalTokens: runSpecs.reduce((sum, entry) => sum + entry.totalTokens, 0),
    reasoningDowngrades: runSpecs.reduce((sum, entry) => sum + entry.reasoningDowngrades, 0),
    providerFailures: runSpecs.reduce((sum, entry) => sum + entry.providerFailures, 0)
  };
}

function runStatusFor(status: CrossPlayRunSpec["status"]): CrossPlayRun["status"] {
  if (status === "completed") return "completed";
  if (status === "partial") return "partial";
  return "failed";
}

function missingRunFailureCode(status: CrossPlayRunSpec["status"]): string {
  if (status === "budget-exhausted") return "CROSS_PLAY_BUDGET_EXHAUSTED";
  if (status === "cancelled") return "CROSS_PLAY_CANCELLED";
  if (status === "interrupted") return "CROSS_PLAY_SERVER_RESTARTED";
  if (status === "queued" || status === "running") return "CROSS_PLAY_RUN_INCOMPLETE";
  return "CROSS_PLAY_RUN_FAILED";
}

function interruptRunningPlan(plan: CrossPlayPlan): CrossPlayPlan {
  if (plan.status !== "running" && !plan.runSpecs.some((entry) => entry.status === "running")) {
    return plan;
  }
  const interruptedAt = new Date().toISOString();
  const runSpecs = plan.runSpecs.map((entry): CrossPlayRunSpec => {
    if (entry.status !== "running" && entry.status !== "queued") return entry;
    return {
      ...entry,
      status: "interrupted",
      errorCode: "CROSS_PLAY_SERVER_RESTARTED",
      finishedAt: interruptedAt
    };
  });
  return {
    ...plan,
    status: "interrupted",
    failureCode: "CROSS_PLAY_SERVER_RESTARTED",
    finishedAt: interruptedAt,
    runSpecs,
    progress: progressFor(runSpecs)
  };
}
