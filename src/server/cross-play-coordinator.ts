import { randomUUID } from "node:crypto";
import type { AgentProfile, ScenarioId } from "../society/contracts";
import {
  type CrossPlayBudget,
  type CrossPlayPlan,
  type CrossPlayRunSpec,
  type FrozenOpponentPool,
  type SocialTruthStore
} from "../society/evaluation";
import {
  ModelRegistry,
  type AgentModelBinding,
  type ModelProfile,
  type ModelTuning
} from "../society/models";
import type { RoomArchiveStore } from "../society/persistence";
import { characterAgentProfile } from "../society/profiles";
import type { SocietyRoom, SocietyRoomEventEnvelope, SocietyRoomRegistry } from "../society/room";
import { SCENARIO_METADATA } from "../society/scenarios";
import type { StrategyProfileSnapshot } from "../society/social/contracts";
import type { ActivationLimiter } from "../society/activation-limiter";
import type { CharacterLibrary } from "./characters";

export interface CreateCrossPlayPlanInput {
  opponentPoolVersion: string;
  scenarioIds: ScenarioId[];
  strategyProfileSnapshotIds?: string[];
  repetitions: number;
  roundsByScenario?: Partial<Record<ScenarioId, number>>;
  requestedReasoningEffort: "xhigh" | "high" | "provider-default";
  budget: CrossPlayBudget;
}

interface CoordinatorDependencies {
  store: SocialTruthStore;
  rooms: SocietyRoomRegistry;
  archive: RoomArchiveStore;
  models: ModelRegistry;
  characters: CharacterLibrary;
  limiter: ActivationLimiter;
}

interface RunningPlanControl {
  cancelled: boolean;
  budgetFailureCode?: string;
  activeRooms: Map<string, SocietyRoom>;
  agentActivations: number;
  totalTokens: number;
}

export class CrossPlayCoordinator {
  private readonly active = new Map<string, RunningPlanControl>();

  constructor(private readonly dependencies: CoordinatorDependencies) {}

  createAndStart(input: CreateCrossPlayPlanInput): CrossPlayPlan {
    const pool = this.dependencies.store.opponentPool(input.opponentPoolVersion);
    if (!pool) throw new Error(`OPPONENT_POOL_NOT_FOUND: '${input.opponentPoolVersion}'.`);
    const plan = buildPlan(pool, input);
    this.dependencies.store.saveCrossPlayPlan(plan);
    queueMicrotask(() => {
      void this.run(plan.planId).catch(() => {
        this.failPlan(plan.planId, "CROSS_PLAY_COORDINATOR_FAILED");
      });
    });
    return plan;
  }

  cancel(planId: string): CrossPlayPlan {
    const plan = this.dependencies.store.crossPlayPlan(planId);
    if (!plan) throw new Error(`CROSS_PLAY_PLAN_NOT_FOUND: '${planId}'.`);
    const control = this.active.get(planId);
    if (control) {
      control.cancelled = true;
      for (const room of control.activeRooms.values()) room.dispose("CROSS_PLAY_CANCELLED");
    }
    return this.dependencies.store.updateCrossPlayPlan(planId, (draft) => {
      if (isTerminalPlan(draft.status)) return;
      const finishedAt = new Date().toISOString();
      draft.status = "cancelled";
      draft.failureCode = "CROSS_PLAY_CANCELLED";
      draft.finishedAt = finishedAt;
      for (const spec of draft.runSpecs) {
        if (spec.status !== "queued") continue;
        spec.status = "cancelled";
        spec.errorCode = "CROSS_PLAY_CANCELLED";
        spec.finishedAt = finishedAt;
      }
    });
  }

  private async run(planId: string): Promise<void> {
    const initial = this.dependencies.store.crossPlayPlan(planId);
    if (!initial || initial.status !== "planned") return;
    const control: RunningPlanControl = {
      cancelled: false,
      activeRooms: new Map(),
      agentActivations: 0,
      totalTokens: 0
    };
    this.active.set(planId, control);
    const startedAt = new Date().toISOString();
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      plan.status = "running";
      plan.startedAt = startedAt;
    });

    const wallTimer = setTimeout(() => {
      this.exhaustBudget(planId, control, "CROSS_PLAY_WALL_TIME_EXCEEDED");
    }, initial.budget.maxWallTimeMs);
    wallTimer.unref?.();

    try {
      let cursor = 0;
      const nextSpec = (): CrossPlayRunSpec | undefined => {
        if (control.cancelled || control.budgetFailureCode) return undefined;
        const spec = initial.runSpecs[cursor];
        cursor += 1;
        return spec;
      };
      const workerCount = Math.min(initial.budget.maxConcurrentRooms, initial.runSpecs.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
          const spec = nextSpec();
          if (!spec) return;
          await this.runSpec(initial, spec, control);
        }
      }));
      this.finishUnstartedRuns(planId, control);
      this.finalizePlan(planId, control);
      this.compilePlanEvaluation(planId);
    } finally {
      clearTimeout(wallTimer);
      for (const room of control.activeRooms.values()) room.dispose("CROSS_PLAY_PLAN_FINISHED");
      control.activeRooms.clear();
      this.active.delete(planId);
    }
  }

  private async runSpec(plan: CrossPlayPlan, sourceSpec: CrossPlayRunSpec, control: RunningPlanControl): Promise<void> {
    const startedAt = new Date().toISOString();
    this.dependencies.store.updateCrossPlayPlan(plan.planId, (draft) => {
      const spec = requiredSpec(draft, sourceSpec.runSpecId);
      spec.status = "running";
      spec.startedAt = startedAt;
    });

    let room: SocietyRoom | undefined;
    let unsubscribe: (() => void) | undefined;
    const metrics = { agentActivations: 0, totalTokens: 0, reasoningDowngrades: 0, providerFailures: 0 };
    try {
      const runtime = this.runtimeFor(plan, sourceSpec);
      room = this.dependencies.rooms.create({
        id: sourceSpec.roomId,
        scenarioId: sourceSpec.scenarioId as ScenarioId,
        profiles: runtime.profiles,
        rounds: sourceSpec.rounds,
        seasonMode: "one-shot",
        modelRegistry: runtime.modelRegistry,
        agentBindings: runtime.agentBindings,
        limiter: this.dependencies.limiter
      });
      control.activeRooms.set(sourceSpec.roomId, room);
      unsubscribe = room.subscribe((envelope) => {
        this.consumeRuntimeEvent(plan.planId, sourceSpec.runSpecId, envelope, metrics, control, plan.budget);
      });
      await room.start();
      const snapshot = room.snapshotFor();
      const providerFailures = metrics.providerFailures > 0;
      const status = control.cancelled
        ? "cancelled"
        : control.budgetFailureCode
          ? "budget-exhausted"
          : snapshot.status === "finished"
            ? providerFailures ? "partial" : "completed"
            : "failed";
      const errorCode = status === "completed" || status === "partial"
        ? undefined
        : control.cancelled
          ? "CROSS_PLAY_CANCELLED"
          : control.budgetFailureCode ?? roomFailureCode(snapshot.error);
      this.completeSpec(plan.planId, sourceSpec.runSpecId, room, status, metrics, errorCode);
    } catch (error) {
      this.completeSpec(
        plan.planId,
        sourceSpec.runSpecId,
        room,
        control.cancelled ? "cancelled" : control.budgetFailureCode ? "budget-exhausted" : "failed",
        metrics,
        control.cancelled ? "CROSS_PLAY_CANCELLED" : control.budgetFailureCode ?? safeErrorCode(error)
      );
    } finally {
      unsubscribe?.();
      control.activeRooms.delete(sourceSpec.roomId);
      if (this.dependencies.rooms.get(sourceSpec.roomId)) this.dependencies.rooms.remove(sourceSpec.roomId);
      this.recordArchiveAvailability(plan.planId, sourceSpec.runSpecId, sourceSpec.roomId);
    }
  }

  private runtimeFor(plan: CrossPlayPlan, spec: CrossPlayRunSpec): {
    profiles: AgentProfile[];
    agentBindings: Record<string, AgentModelBinding>;
    modelRegistry: ModelRegistry;
  } {
    const pool = this.dependencies.store.opponentPool(plan.opponentPoolVersion);
    if (!pool) throw new Error(`OPPONENT_POOL_NOT_FOUND: '${plan.opponentPoolVersion}'.`);
    const entries = new Map(pool.entries.map((entry) => [entry.strategyProfileSnapshotId, entry]));
    const selectedSnapshots = Object.entries(spec.seatBindings).map(([actorId, snapshotId]) => {
      const snapshot = entries.get(snapshotId)?.strategyProfileSnapshot;
      if (!snapshot) throw new Error(`FROZEN_STRATEGY_SNAPSHOT_MISSING: '${snapshotId}'.`);
      if (snapshot.actorId !== actorId) {
        // Actor ids are seat-local. The immutable person/config is rebound to
        // the planned seat; this does not transfer another person's memory.
        return structuredClone(snapshot);
      }
      return structuredClone(snapshot);
    });
    const modelRegistry = frozenRuntimeRegistry(this.dependencies.models, selectedSnapshots);
    const profiles: AgentProfile[] = [];
    const agentBindings: Record<string, AgentModelBinding> = {};
    Object.entries(spec.seatBindings).forEach(([actorId, snapshotId], seatIndex) => {
      const snapshot = selectedSnapshots[seatIndex];
      if (!snapshot || snapshot.strategyProfileSnapshotId !== snapshotId) {
        throw new Error(`CROSS_PLAY_SEAT_BINDING_INVALID: '${actorId}'.`);
      }
      const character = this.dependencies.characters.resolve(snapshot.characterId);
      if (!character) throw new Error(`CHARACTER_NOT_FOUND: '${snapshot.characterId}'.`);
      const profile = characterAgentProfile(character, seatIndex, [snapshot.modelConfig.modelId]);
      if (profile.id !== actorId) throw new Error(`CROSS_PLAY_ACTOR_ID_INVALID: '${actorId}'.`);
      if (plan.requestedReasoningEffort !== "provider-default") {
        profile.reasoningEffort = plan.requestedReasoningEffort;
      }
      profiles.push(profile);
      const tuningOverrides = tuningFromSnapshot(snapshot);
      if (plan.requestedReasoningEffort === "provider-default") delete tuningOverrides.reasoningEffort;
      else tuningOverrides.reasoningEffort = plan.requestedReasoningEffort;
      agentBindings[actorId] = {
        defaultModelProfileId: snapshot.modelConfig.modelProfileId,
        tuningOverrides,
        contextPolicyId: snapshot.contextPolicy.id,
        contextOverrides: structuredClone(snapshot.contextPolicy)
      };
    });
    return { profiles, agentBindings, modelRegistry };
  }

  private consumeRuntimeEvent(
    planId: string,
    runSpecId: string,
    envelope: SocietyRoomEventEnvelope,
    metrics: { agentActivations: number; totalTokens: number; reasoningDowngrades: number; providerFailures: number },
    control: RunningPlanControl,
    budget: CrossPlayBudget
  ): void {
    const event = envelope.event;
    if (event.type === "agent.updated") {
      metrics.agentActivations += 1;
      metrics.totalTokens += Math.max(0, event.totalTokens);
      control.agentActivations += 1;
      control.totalTokens += Math.max(0, event.totalTokens);
      if (control.agentActivations > budget.maxAgentActivations) {
        this.exhaustBudget(planId, control, "CROSS_PLAY_ACTIVATION_BUDGET_EXHAUSTED");
      } else if (control.totalTokens > budget.maxTotalTokens) {
        this.exhaustBudget(planId, control, "CROSS_PLAY_TOKEN_BUDGET_EXHAUSTED");
      }
    } else if (event.type === "runtime.notice" && event.category === "reasoning" && event.severity === "warning") {
      metrics.reasoningDowngrades += 1;
    } else if (event.type === "runtime.notice" && event.category === "provider" && event.severity === "error") {
      metrics.providerFailures += 1;
    }
    // Persisted at run completion. The room checkpoint already holds every
    // raw notice; orchestration never copies provider response text here.
    void runSpecId;
  }

  private exhaustBudget(planId: string, control: RunningPlanControl, code: string): void {
    if (control.budgetFailureCode || control.cancelled) return;
    control.budgetFailureCode = code;
    for (const room of control.activeRooms.values()) room.dispose(code);
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      plan.failureCode = code;
    });
  }

  private completeSpec(
    planId: string,
    runSpecId: string,
    room: SocietyRoom | undefined,
    status: CrossPlayRunSpec["status"],
    metrics: { agentActivations: number; totalTokens: number; reasoningDowngrades: number; providerFailures: number },
    errorCode?: string
  ): void {
    const snapshot = room?.snapshotFor();
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      const spec = requiredSpec(plan, runSpecId);
      spec.status = status;
      spec.agentActivations = metrics.agentActivations;
      spec.totalTokens = metrics.totalTokens;
      spec.reasoningDowngrades = metrics.reasoningDowngrades;
      spec.providerFailures = metrics.providerFailures;
      spec.finishedAt = new Date().toISOString();
      if (snapshot) {
        spec.observedRoleBindings = Object.fromEntries(
          snapshot.participants.map((participant) => [participant.profile.id, participant.role ?? "unknown"])
        );
      }
      if (errorCode) spec.errorCode = errorCode;
    });
  }

  private recordArchiveAvailability(planId: string, runSpecId: string, roomId: string): void {
    let available = false;
    let failureCode = "CROSS_PLAY_ARCHIVE_MISSING";
    try {
      available = Boolean(this.dependencies.archive.load(roomId));
    } catch (error) {
      failureCode = safeErrorCode(error);
    }
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      const spec = requiredSpec(plan, runSpecId);
      if (available) {
        spec.archiveRef = `room:${roomId}`;
        return;
      }
      if (spec.status === "completed") spec.status = "partial";
      spec.errorCode ??= failureCode;
    });
  }

  private finishUnstartedRuns(planId: string, control: RunningPlanControl): void {
    const status: CrossPlayRunSpec["status"] = control.cancelled ? "cancelled" : "budget-exhausted";
    const code = control.cancelled ? "CROSS_PLAY_CANCELLED" : control.budgetFailureCode;
    if (!code) return;
    const finishedAt = new Date().toISOString();
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      for (const spec of plan.runSpecs) {
        if (spec.status !== "queued") continue;
        spec.status = status;
        spec.errorCode = code;
        spec.finishedAt = finishedAt;
      }
    });
  }

  private finalizePlan(planId: string, control: RunningPlanControl): void {
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      const successes = plan.runSpecs.filter((entry) => entry.status === "completed" || entry.status === "partial").length;
      const hasPartial = plan.runSpecs.some((entry) => entry.status !== "completed");
      plan.status = control.cancelled
        ? "cancelled"
        : successes === 0
          ? "failed"
          : hasPartial ? "partial" : "completed";
      plan.failureCode = control.cancelled
        ? "CROSS_PLAY_CANCELLED"
        : control.budgetFailureCode ?? plan.failureCode;
      plan.finishedAt = new Date().toISOString();
    });
  }

  private compilePlanEvaluation(planId: string): void {
    const plan = this.dependencies.store.crossPlayPlan(planId);
    if (!plan) return;
    const checkpoints = plan.runSpecs.flatMap((spec) => {
      try {
        const checkpoint = this.dependencies.archive.load(spec.roomId);
        return checkpoint ? [checkpoint] : [];
      } catch {
        return [];
      }
    });
    this.dependencies.store.compileCrossPlayPlanEvaluation(planId, checkpoints);
  }

  private failPlan(planId: string, code: string): void {
    const existing = this.dependencies.store.crossPlayPlan(planId);
    if (!existing || isTerminalPlan(existing.status)) return;
    const finishedAt = new Date().toISOString();
    this.dependencies.store.updateCrossPlayPlan(planId, (plan) => {
      plan.status = "failed";
      plan.failureCode = code;
      plan.finishedAt = finishedAt;
      for (const spec of plan.runSpecs) {
        if (spec.status !== "queued" && spec.status !== "running") continue;
        spec.status = "failed";
        spec.errorCode = code;
        spec.finishedAt = finishedAt;
      }
    });
  }
}

function buildPlan(pool: FrozenOpponentPool, input: CreateCrossPlayPlanInput): CrossPlayPlan {
  const selected = new Set(input.strategyProfileSnapshotIds ?? pool.entries.map((entry) => entry.strategyProfileSnapshotId));
  const unknown = [...selected].filter((id) => !pool.entries.some((entry) => entry.strategyProfileSnapshotId === id));
  if (unknown.length) throw new Error(`OPPONENT_POOL_ENTRY_NOT_FOUND: '${unknown[0]}'.`);
  const planId = `cross-play-plan-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const runSpecs: CrossPlayRunSpec[] = [];
  for (const scenarioId of [...new Set(input.scenarioIds)]) {
    const metadata = SCENARIO_METADATA[scenarioId];
    if (!metadata) throw new Error(`SCENARIO_NOT_FOUND: '${scenarioId}'.`);
    const entries = pool.entries
      .filter((entry) => selected.has(entry.strategyProfileSnapshotId))
      .filter((entry) => entry.supportedScenarioIds.includes(scenarioId))
      .filter((entry) => Boolean(entry.strategyProfileSnapshot))
      .sort((left, right) => left.strategyProfileSnapshotId.localeCompare(right.strategyProfileSnapshotId));
    const seatCount = metadata.players;
    if (entries.length < seatCount) {
      throw new Error(`CROSS_PLAY_ROSTER_TOO_SMALL: '${scenarioId}' needs ${seatCount} frozen character/config snapshots.`);
    }
    const characterIds = entries.map((entry) => entry.strategyProfileSnapshot!.characterId);
    if (new Set(characterIds).size !== characterIds.length) {
      throw new Error(`CROSS_PLAY_CHARACTER_DUPLICATE: '${scenarioId}' requires one stable character per frozen entry.`);
    }
    const rounds = input.roundsByScenario?.[scenarioId] ?? metadata.defaultRounds;
    if (!Number.isInteger(rounds) || rounds < metadata.minRounds || rounds > metadata.maxRounds) {
      throw new Error(`CROSS_PLAY_ROUNDS_INVALID: '${scenarioId}' requires ${metadata.minRounds}-${metadata.maxRounds} rounds.`);
    }
    const rotations = seatCount === 2 ? pairwiseRotations(entries) : cyclicRotations(entries, seatCount);
    for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
      rotations.forEach((rotation, rotationIndex) => {
        const index = runSpecs.length + 1;
        const seatBindings = Object.fromEntries(rotation.map((entry, seatIndex) => [actorIdFor(seatIndex), entry.strategyProfileSnapshotId]));
        const characterBindings = Object.fromEntries(rotation.map((entry, seatIndex) => [actorIdFor(seatIndex), entry.strategyProfileSnapshot!.characterId]));
        runSpecs.push({
          runSpecId: `${planId}:run-${String(index).padStart(4, "0")}`,
          roomId: `eval_${planId.slice(-12)}_${String(index).padStart(4, "0")}`,
          scenarioId,
          rounds,
          repetition,
          rotationIndex,
          seatBindings,
          characterBindings,
          roleAssignment: "scenario-runtime-observed",
          firstPlayerBalance: "seat-permutation",
          status: "queued",
          agentActivations: 0,
          totalTokens: 0,
          reasoningDowngrades: 0,
          providerFailures: 0,
          createdAt,
          schemaVersion: 1
        });
      });
    }
  }
  if (!runSpecs.length) throw new Error("CROSS_PLAY_RUNS_REQUIRED: The selected pool/scenarios produced no runs.");
  if (runSpecs.length > input.budget.maxRuns) {
    throw new Error(`CROSS_PLAY_RUN_BUDGET_EXCEEDED: Plan needs ${runSpecs.length} runs but maxRuns is ${input.budget.maxRuns}.`);
  }
  return {
    planId,
    opponentPoolVersion: pool.opponentPoolVersion,
    scenarioIds: [...new Set(input.scenarioIds)],
    strategyProfileSnapshotIds: [...selected].sort(),
    status: "planned",
    requestedReasoningEffort: input.requestedReasoningEffort,
    budget: structuredClone(input.budget),
    runSpecs,
    progress: {
      queuedRuns: runSpecs.length,
      runningRuns: 0,
      finishedRuns: 0,
      agentActivations: 0,
      totalTokens: 0,
      reasoningDowngrades: 0,
      providerFailures: 0
    },
    createdAt,
    schemaVersion: 1
  };
}

function pairwiseRotations(entries: FrozenOpponentPool["entries"]): Array<FrozenOpponentPool["entries"]> {
  const rotations: Array<FrozenOpponentPool["entries"]> = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      rotations.push([entries[left], entries[right]], [entries[right], entries[left]]);
    }
  }
  return rotations;
}

function cyclicRotations(entries: FrozenOpponentPool["entries"], seatCount: number): Array<FrozenOpponentPool["entries"]> {
  return entries.map((_entry, rotation) =>
    Array.from({ length: seatCount }, (_unused, seat) => entries[(rotation + seat) % entries.length])
  );
}

function frozenRuntimeRegistry(deployment: ModelRegistry, snapshots: StrategyProfileSnapshot[]): ModelRegistry {
  const deploymentState = deployment.snapshot();
  const registry = new ModelRegistry({
    providers: deploymentState.providers,
    modelProfiles: deploymentState.modelProfiles,
    contextPolicies: deploymentState.contextPolicies,
    globalDefaults: {}
  });
  const fingerprints = new Map<string, string>();
  for (const snapshot of snapshots) {
    const provider = deployment.providerProfile(snapshot.modelConfig.providerProfileId);
    if (!provider || !provider.enabled) {
      throw new Error(`PROVIDER_PROFILE_MISSING: '${snapshot.modelConfig.providerProfileId}'.`);
    }
    const fingerprint = JSON.stringify({
      modelId: snapshot.modelConfig.modelId,
      providerProfileId: snapshot.modelConfig.providerProfileId,
      contextWindow: snapshot.modelConfig.contextWindow,
      capabilities: snapshot.modelConfig.capabilities,
      contextPolicy: snapshot.contextPolicy
    });
    const previous = fingerprints.get(snapshot.modelConfig.modelProfileId);
    if (previous && previous !== fingerprint) {
      throw new Error(`FROZEN_MODEL_PROFILE_CONFLICT: '${snapshot.modelConfig.modelProfileId}'.`);
    }
    fingerprints.set(snapshot.modelConfig.modelProfileId, fingerprint);
    registry.upsertContextPolicy(structuredClone(snapshot.contextPolicy));
    const current = deployment.modelProfile(snapshot.modelConfig.modelProfileId);
    const profile: ModelProfile = {
      id: snapshot.modelConfig.modelProfileId,
      name: current?.name ?? snapshot.modelConfig.modelId,
      providerProfileId: snapshot.modelConfig.providerProfileId,
      modelId: snapshot.modelConfig.modelId,
      contextWindow: snapshot.modelConfig.contextWindow,
      contextWindowSource: "manual",
      capabilities: structuredClone(snapshot.modelConfig.capabilities),
      defaults: tuningFromSnapshot(snapshot),
      contextPolicyId: snapshot.contextPolicy.id,
      enabled: true
    };
    registry.upsertModelProfile(profile);
  }
  return registry;
}

function tuningFromSnapshot(snapshot: StrategyProfileSnapshot): Partial<ModelTuning> {
  const allowed = new Set<keyof ModelTuning>([
    "temperature", "topP", "presencePenalty", "frequencyPenalty", "maxOutputTokens",
    "reasoningEffort", "reasoningSummary", "verbosity", "toolChoice", "parallelToolCalls",
    "truncation", "store", "seed", "stop", "maxTurns", "requestTimeoutMs",
    "retryMaxAttempts", "retryInitialDelayMs", "promptCacheRetention"
  ]);
  const tuning: Partial<ModelTuning> = {};
  for (const [key, resolved] of Object.entries(snapshot.modelConfig.tuning)) {
    if (!allowed.has(key as keyof ModelTuning) || !resolved || !("value" in resolved)) continue;
    (tuning as Record<string, unknown>)[key] = structuredClone(resolved.value);
  }
  return tuning;
}

function requiredSpec(plan: CrossPlayPlan, runSpecId: string): CrossPlayRunSpec {
  const spec = plan.runSpecs.find((entry) => entry.runSpecId === runSpecId);
  if (!spec) throw new Error(`CROSS_PLAY_RUN_SPEC_NOT_FOUND: '${runSpecId}'.`);
  return spec;
}

function actorIdFor(seatIndex: number): string {
  return `agent-${String(seatIndex + 1).padStart(2, "0")}`;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = /^([A-Z][A-Z0-9_]{2,80})(?::|$)/.exec(message)?.[1];
  return prefix ?? "CROSS_PLAY_RUN_FAILED";
}

function roomFailureCode(message: string | undefined): string {
  return message ? safeErrorCode(new Error(message)) : "CROSS_PLAY_ROOM_DID_NOT_FINISH";
}

function isTerminalPlan(status: CrossPlayPlan["status"]): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled" || status === "interrupted";
}
