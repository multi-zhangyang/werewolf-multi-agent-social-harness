import { randomUUID } from "node:crypto";
import type { Action, ActorId, WorldSpec } from "./contracts";
import { applyAction, createWorld, currentActor, observeWorld, publicObservation } from "./world";
import { advanceMind, createMind, resolvePredictions } from "./mind";
import { reconcilePlan } from "./plans";
import type { CognitiveProtocol } from "./cognition";
import { PartnerDecisionError, type PartnerActivity, type PartnerParticipant, type PartnerDecisionCase } from "./agent";
import { PartnerStore, hashToken, type StoredPartnerRun, type StoredStudy } from "./store";
import type { ActionRequest, CreateRun, CreatedRun, ForkRequest, Mechanism, PartnerSnapshot, ResearchMetrics, RunSummary, StudySpec, StudyView, ToolActivity } from "./api-types";

export class PartnerError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "PartnerError"; }
}
export interface PartnerViewer { owner: boolean; actorId?: ActorId; research?: boolean }
export type PartnerFactory = (mechanism: Mechanism, protocol?: CognitiveProtocol) => PartnerParticipant;
const actorIds: ActorId[] = ["a", "b"];
const apology = "我没有履行上次的承诺。这是我的责任，我希望有机会修复合作。";
export const studyNote = "第一轮承诺返还一半、投资 6、实际返还 0 为实验设置；三个分支仅改变道歉与真实补偿，之后由模型自主行动。补偿同时改变资金与社会信号。";
const terminal = new Set(["completed", "failed", "stopped"]);

export class PartnerService {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private singleSteps = new Set<string>();
  private studyJobs = new Map<string, Promise<void>>();
  private closing = false;
  private liveActivities = new Map<string, Map<string, ToolActivity>>();
  private runtimeListeners = new Map<string, Set<(activities: ToolActivity[]) => void>>();
  constructor(readonly store: PartnerStore, private readonly factory: PartnerFactory) {}

  /** Research-only presentation channel. It is never read by an actor or copied to a fork. */
  runtimeActivities(id: string): ToolActivity[] {
    const live = this.liveActivities.get(id);
    return this.get(id).activities.map(activity => live?.get(activity.id) ?? activity);
  }
  subscribeRuntime(id: string, listener: (activities: ToolActivity[]) => void): () => void {
    const listeners = this.runtimeListeners.get(id) ?? new Set(); listeners.add(listener); this.runtimeListeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.runtimeListeners.delete(id); };
  }
  private publishRuntime(id: string, activities: ToolActivity[]): void {
    const listeners = this.runtimeListeners.get(id);
    if (!listeners) return;
    // A renderer or disconnected SSE client cannot affect the actor's decision.
    for (const listener of listeners) {
      try { listener(activities); } catch { listeners.delete(listener); }
    }
    if (!listeners.size) this.runtimeListeners.delete(id);
  }

  get(id: string): StoredPartnerRun {
    const run = this.store.get(id); if (!run) throw new PartnerError("对局不存在", 404); return run;
  }
  list(): RunSummary[] { return this.store.list().filter(r => !r.hidden).map(summary); }
  create(spec: CreateRun, worldOverride?: WorldSpec): CreatedRun {
    const runSpec = { ...spec, mechanism: spec.mechanism ?? "full", protocol: "responses-v1" as const, maxRounds: spec.maxRounds ?? 3 };
    const worldSpec: WorldSpec = { maxRounds: runSpec.maxRounds, seed: spec.seed ?? 1, actors: {
      a: { name: spec.mode === "human" ? "你" : "林舟", kind: spec.mode === "human" ? "human" : "ai", agreeableness: spec.agreeableness?.[0] ?? 0.2, ...spec.actorSettings?.a },
      b: { name: "沈言", kind: "ai", agreeableness: spec.agreeableness?.[1] ?? 0.8, ...spec.actorSettings?.b },
    } };
    const world = createWorld(worldOverride ?? worldSpec, randomUUID());
    const ownerToken = randomUUID(); const playerToken = spec.mode === "human" ? randomUUID() : undefined;
    const run: StoredPartnerRun = { id: world.id, title: "合伙人：一次失约", createdAt: new Date().toISOString(), version: 1,
      status: "paused", spec: runSpec, ownerHash: hashToken(ownerToken), playerHashes: playerToken ? { a: hashToken(playerToken) } : {},
      world, minds: { a: createMind("a", world.actors.a.privateObjective), b: createMind("b", world.actors.b.privateObjective) },
      memories: { a: [], b: [] }, sessions: { a: [], b: [] }, activities: [] };
    this.store.transact(() => { this.store.save(run); this.store.checkpoint(run); });
    if (spec.autoStart !== false) this.control(run.id, "resume");
    return { id: run.id, ownerToken, playerToken, snapshot: this.snapshot(run.id, { owner: true, actorId: playerToken ? "a" : undefined }) };
  }
  snapshot(id: string, viewer: PartnerViewer): PartnerSnapshot {
    const run = this.get(id);
    if (viewer.research && !viewer.owner) throw new PartnerError("研究视角需要本局所有者权限", 403);
    const observation = viewer.actorId ? observeWorld(run.world, viewer.actorId) : publicObservation(run.world);
    return { ...summary(run), version: run.version, observation,
      viewer: { actorId: viewer.actorId, research: Boolean(viewer.research && viewer.owner), canControl: viewer.owner,
        canAct: Boolean(viewer.actorId && run.world.actors[viewer.actorId].kind === "human" && currentActor(run.world) === viewer.actorId && run.status === "waiting-human") },
      ...(viewer.actorId ? { ownMind: run.minds[viewer.actorId] } : {}), error: run.error, activeActor: run.activeActor,
      ...(viewer.research && viewer.owner ? { research: { world: run.world, minds: run.minds, activities: run.activities,
        checkpoints: this.store.checkpoints(id).map(({ id, revision, round, phase, createdAt }) => ({ id, revision, round, phase, createdAt })),
        metrics: this.metrics(id), experimentNote: run.experimentNote } } : {}) };
  }
  metrics(id: string): ResearchMetrics {
    return this.store.metrics(id);
  }
  humanAction(id: string, actorId: ActorId, request: ActionRequest): void {
    const run = this.get(id);
    if (run.world.actors[actorId].kind !== "human") throw new PartnerError("该席位由 AI 控制", 403);
    // A retransmitted accepted command is safe even if the opponent has already moved.
    if (run.world.commands.some(c => c.id === request.commandId)) {
      applyAction(run.world, actorId, request.action, request.commandId); return;
    }
    if (run.status !== "waiting-human") throw new PartnerError("当前不接受玩家行动", 409);
    if (run.world.revision !== request.expectedRevision) throw new PartnerError("局面已更新，请按当前合法行动重新提交", 409);
    const next = applyAction(run.world, actorId, request.action, request.commandId);
    this.commit(run, next);
    if (next.phase !== "finished") this.control(id, "resume");
  }
  control(id: string, command: "pause" | "resume" | "step" | "stop"): void {
    const run = this.get(id);
    if (run.world.phase === "finished") return;
    if (run.status === "stopped" && command !== "stop") throw new PartnerError("已停止的对局请从检查点分叉", 409);
    if (command === "pause" || command === "stop") {
      run.status = command === "pause" ? "paused" : "stopped";
      this.jobs.get(id)?.controller.abort(); this.singleSteps.delete(id);
      if (run.activeActor) {
        this.finishActivities(run, command === "pause" ? "对局已暂停，本次调用未提交" : "对局已停止，本次调用未提交",
          { revision: run.world.revision, actorId: run.activeActor });
        delete run.activeActor;
      }
    } else {
      run.status = "running"; delete run.error;
      if (command === "step") this.singleSteps.add(id); else this.singleSteps.delete(id);
    }
    run.version++; this.store.save(run);
    if (run.status === "running") this.schedule(id);
  }
  private commit(run: StoredPartnerRun, world: StoredPartnerRun["world"]): void {
    run.world = world; run.version++; delete run.activeActor; delete run.error;
    const psychology = run.spec.mechanism === "no-mind" ? "off" : run.spec.mechanism === "no-inertia" ? "no-inertia" : "hybrid";
    for (const id of actorIds) {
      run.minds[id] = resolvePredictions(advanceMind(run.minds[id], world.revision, psychology), observeWorld(world, id));
      if (psychology !== "off") run.minds[id] = reconcilePlan(run.minds[id], observeWorld(world, id));
    }
    run.status = world.phase === "finished" ? "completed" : "running";
    this.store.transact(() => { this.store.save(run); this.store.checkpoint(run); });
  }
  private schedule(id: string): void {
    if (this.closing || this.jobs.has(id) || this.jobs.size >= 2) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.drive(id, controller.signal)).finally(() => {
      this.jobs.delete(id);
      if (!this.closing) for (const run of this.store.list()) if (run.status === "running") this.schedule(run.id);
    });
    this.jobs.set(id, { controller, promise });
  }
  private async drive(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.closing) {
      const before = this.get(id); if (before.status !== "running") return;
      const actorId = currentActor(before.world);
      if (!actorId) { before.status = "completed"; before.version++; this.store.save(before); return; }
      if (before.world.actors[actorId].kind === "human") {
        before.status = "waiting-human"; before.version++; this.store.save(before); return;
      }
      before.activeActor = actorId; before.version++; this.store.save(before);
      let pendingCase: PartnerDecisionCase | undefined;
      let committed = false;
      const activation = { revision: before.world.revision, actorId };
      try {
        const participant = this.factory(before.spec.mechanism ?? "full", "responses-v1");
        const decision = await participant.decide({ world: before.world, actorId, mind: before.minds[actorId], memories: before.memories[actorId],
          sessionItems: before.sessions[actorId], signal, onActivity: activity => { if (!signal.aborted) this.activity(id, before.world.revision, activity); } });
        pendingCase = decision.decisionCase;
        const latest = this.get(id);
        if (signal.aborted || latest.status !== "running" || latest.world.revision !== before.world.revision) {
          decision.decisionCase.status = "failed"; decision.decisionCase.error = "调用已取消，行动未提交";
          decision.decisionCase.failures++; this.store.saveCase(id, decision.decisionCase); return;
        }
        const next = applyAction(latest.world, actorId, decision.action, `agent:${decision.decisionCase.id}`);
        latest.minds[actorId] = decision.mind; latest.memories[actorId] = decision.memories; latest.sessions[actorId] = decision.sessionItems;
        this.finishActivities(latest, "本次激活已结束，行动已提交", activation, "completed");
        this.store.transact(() => { this.store.saveCase(id, decision.decisionCase); this.commit(latest, next); });
        committed = true;
        if (this.singleSteps.delete(id) && next.phase !== "finished") { this.control(id, "pause"); return; }
      } catch (error) {
        const latest = this.get(id);
        if (error instanceof PartnerDecisionError) this.store.saveCase(id, error.decisionCase);
        else if (pendingCase) { pendingCase.status = "failed"; pendingCase.error = cleanError(error); pendingCase.failures++; this.store.saveCase(id, pendingCase); }
        if (signal.aborted || latest.status !== "running" || latest.world.revision !== activation.revision) return;
        latest.status = "failed"; latest.error = cleanError(error); delete latest.activeActor;
        latest.version++; this.finishActivities(latest, "行动未提交", activation); this.store.save(latest); return;
      } finally {
        const latest = this.get(id);
        let changed = false;
        if (latest.activeActor === actorId && latest.world.revision === activation.revision) { delete latest.activeActor; changed = true; }
        changed = this.finishActivities(latest, committed ? "本次激活已结束，行动已提交" : "调用已结束，行动未提交",
          activation, committed ? "completed" : "failed") || changed;
        if (changed) { latest.version++; this.store.save(latest); }
      }
    }
  }
  private activity(id: string, revision: number, event: PartnerActivity): void {
    if (event.kind === "model_delta") {
      const live = this.liveActivities.get(id);
      const previous = [...live?.values() ?? []].find(item => item.callId === event.callId && item.actorId === event.actorId && item.revision === revision);
      if (previous && event.stream) {
        const activity = { ...previous, stream: event.stream }; live!.set(activity.id, activity); this.publishRuntime(id, [activity]);
      }
      return;
    }
    const run = this.get(id);
    if (run.world.revision !== revision || run.status !== "running") return;
    if (event.kind === "retry") this.finishActivities(run, "本次尝试失败，行动未提交；准备重试",
      { revision, actorId: event.actorId }, "failed", event.at);
    const activityName = event.tool ?? (event.kind.startsWith("model") ? "模型决策" : event.kind === "retry" ? "未提交重试" : "角色 Agent");
    const name = event.channel === "shadow" ? `独立记录 · ${activityName}` : activityName;
    const end = event.kind.endsWith("end") || event.kind.endsWith("error");
    const found = end ? [...run.activities].reverse().find(a => a.actorId === event.actorId && a.revision === revision && a.name === name && a.status === "running" && (!event.callId || a.callId === event.callId)) : undefined;
    if (found) {
      Object.assign(found, this.liveActivities.get(id)?.get(found.id));
      found.status = event.kind.endsWith("error") ? "failed" : "completed"; found.finishedAt = event.at; found.output = event.output ?? event.message;
      if (event.stream) found.stream = event.stream;
      this.liveActivities.get(id)?.delete(found.id);
    }
    else {
      const activity: ToolActivity = { id: event.id, actorId: event.actorId, revision, name, startedAt: event.at,
        status: event.kind === "retry" ? "completed" : end ? event.kind.endsWith("error") ? "failed" : "completed" : "running",
        ...(event.kind === "retry" || end ? { finishedAt: event.at } : {}), input: event.input, output: event.output ?? event.message,
        kind: event.kind.startsWith("model") ? "model" : event.kind.startsWith("tool") ? "tool" : event.kind === "retry" ? "retry" : "agent",
        channel: event.channel ?? "decision", attempt: event.attempt, callId: event.callId, stream: event.stream };
      run.activities.push(activity);
      if (event.kind === "model_start") {
        const live = this.liveActivities.get(id) ?? new Map(); live.set(activity.id, activity); this.liveActivities.set(id, live);
      }
    }
    run.activities = run.activities.slice(-250); run.version++; this.store.save(run);
    this.publishRuntime(id, [found ?? run.activities.at(-1)!]);
  }
  private finishActivities(run: StoredPartnerRun, message: string, activation: { revision: number; actorId: ActorId },
    status: "completed" | "failed" = "failed", finishedAt = new Date().toISOString()): boolean {
    let changed = false;
    for (const activity of run.activities) if (activity.status === "running" && activity.revision === activation.revision && activity.actorId === activation.actorId) {
      Object.assign(activity, this.liveActivities.get(run.id)?.get(activity.id));
      this.liveActivities.get(run.id)?.delete(activity.id);
      // Committing the action establishes completion of the outer activation only.
      // A specific model/tool without an end callback still has incomplete telemetry.
      const incomplete = status === "completed" && activity.name !== "角色 Agent";
      activity.status = incomplete ? "failed" : status;
      activity.output = incomplete ? "行动已提交，但本模型或工具未报告结束，活动状态不完整" : message;
      activity.finishedAt = finishedAt; changed = true;
      this.publishRuntime(run.id, [activity]);
    }
    return changed;
  }
  fork(id: string, request: ForkRequest): CreatedRun {
    const source = this.get(id); const checkpoint = this.store.getCheckpoint(request.checkpointId);
    if (!checkpoint || checkpoint.runId !== id) throw new PartnerError("检查点不属于本局", 404);
    const ownerToken = randomUUID(); const playerToken = source.spec.mode === "human" ? randomUUID() : undefined;
    const run: StoredPartnerRun = { ...structuredClone(source), ...structuredClone(checkpoint.state), id: randomUUID(), createdAt: new Date().toISOString(),
      version: 1, status: "paused", ownerHash: hashToken(ownerToken), playerHashes: playerToken ? { a: hashToken(playerToken) } : {},
      activities: [], parentId: id, checkpointId: checkpoint.id, hidden: false };
    delete run.error; delete run.activeActor; delete run.studyId; delete run.interventionId;
    run.world.id = run.id;
    run.spec = { ...run.spec, protocol: "responses-v1" };
    if (request.intervention) {
      if (run.world.phase !== "repair") throw new PartnerError("修复干预只能从返还后的 repair 检查点开始", 409);
      const { kind, amount } = request.intervention;
      const action: Action = { type: "repair", compensation: kind === "compensation" ? amount ?? 9 : 0,
        ...(kind !== "none" ? { message: apology } : {}) };
      run.world = applyAction(run.world, run.world.trustee, action, `intervention:${run.id}`);
      run.condition = kind;
      run.experimentNote = source.hidden && source.experimentNote === studyNote ? studyNote
        : `从第 ${checkpoint.round} 轮返还后的检查点复制。此前为原局真实记录；本次干预为${kind === "none" ? "不道歉、不补偿" : kind === "apology" ? "固定道歉、补偿 0" : `相同道歉、真实补偿 ${amount ?? 9}`}。后续世界独立运行。`;
    }
    for (const actorId of actorIds) run.minds[actorId] = resolvePredictions(run.minds[actorId], observeWorld(run.world, actorId));
    if (run.world.phase === "finished") run.status = "completed";
    this.store.transact(() => { this.store.save(run); this.store.inheritCheckpoints(source.id, run, checkpoint.revision); this.store.checkpoint(run); });
    if (request.autoStart !== false) this.control(run.id, "resume");
    return { id: run.id, ownerToken, playerToken, snapshot: this.snapshot(run.id, { owner: true, research: true, actorId: playerToken ? "a" : undefined }) };
  }
  createStudy(spec: StudySpec): { study: StudyView; ownerToken: string } {
    const ownerToken = randomUUID();
    spec = { ...spec, protocol: "responses-v1" };
    const study: StoredStudy = { id: randomUUID(), createdAt: new Date().toISOString(), ownerHash: hashToken(ownerToken), spec, status: "paused", rows: [] };
    for (let repeat = 0; repeat < spec.repeats; repeat++) for (const agreeableness of spec.agreeableness) for (const mechanism of spec.mechanisms) {
      const created = this.create({ mode: "observe", protocol: spec.protocol, maxRounds: spec.maxRounds, agreeableness: [agreeableness, 0.5], mechanism, seed: spec.seed + repeat, autoStart: false },
        { maxRounds: spec.maxRounds, seed: spec.seed + repeat, actors: { a: { name: "林舟", kind: "ai", agreeableness, productivity: 3 }, b: { name: "沈言", kind: "ai", agreeableness: 0.5, productivity: 3 } } });
      const source = this.get(created.id); source.hidden = true; source.ownerHash = study.ownerHash; source.experimentNote = studyNote;
      // Both branches' initial history is executed by the authoritative engine.
      source.world = applyAction(source.world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "setup:offer");
      this.store.checkpoint(source);
      source.world = applyAction(source.world, "a", { type: "invest", amount: 6 }, "setup:invest");
      this.store.checkpoint(source);
      source.world = applyAction(source.world, "b", { type: "settle", returnAmount: 0 }, "setup:betrayal");
      source.version++;
      this.store.transact(() => { this.store.save(source); this.store.checkpoint(source); });
      for (const condition of ["none", "apology", "compensation"] as const) {
        const fork = this.fork(source.id, { checkpointId: `${source.id}:${source.world.revision}`, intervention: { kind: condition, amount: 9 }, autoStart: false });
        const run = this.get(fork.id); run.studyId = study.id; run.ownerHash = study.ownerHash;
        this.store.save(run); study.rows.push({ runId: run.id, condition, agreeableness, mechanism, repeat });
      }
    }
    // Deterministic shuffle persists execution order before any model invocation.
    let random = spec.seed >>> 0;
    for (let i = study.rows.length - 1; i > 0; i--) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const j = random % (i + 1); [study.rows[i], study.rows[j]] = [study.rows[j], study.rows[i]]; }
    this.store.saveStudy(study);
    return { study: this.studyView(study.id), ownerToken };
  }
  getStudy(id: string): StoredStudy { const study = this.store.getStudy(id); if (!study) throw new PartnerError("实验不存在", 404); return study; }
  studyView(id: string): StudyView {
    const study = this.getStudy(id);
    const rows = study.rows.map(row => {
      const run = this.get(row.runId); const deals = [...run.world.completedDeals, run.world.deal];
      const trusteeRound = deals.find(d => d.round === 2); const investorRound = deals.find(d => d.round === 3);
      return { ...row, status: run.status, error: run.error,
        returned: trusteeRound?.returned ?? null, compensation: run.world.events.some(e => e.round === 2 && e.kind === "repair") ? trusteeRound?.compensation ?? null : null,
        investment: investorRound?.investment ?? null,
        payoff: run.world.phase === "finished" ? run.world.actors.a.wallet - run.world.actors.a.initialWallet : null,
        durationMs: this.metrics(run.id).durationMs };
    });
    return { id, status: study.status, createdAt: study.createdAt, spec: study.spec, total: rows.length,
      completed: rows.filter(row => row.status === "completed").length, failed: rows.filter(row => row.status === "failed").length, note: studyNote, rows };
  }
  studyControl(id: string, command: "pause" | "resume" | "stop"): void {
    const study = this.getStudy(id);
    if (study.status === "stopped") return;
    study.status = command === "resume" ? "running" : command === "pause" ? "paused" : "stopped"; this.store.saveStudy(study);
    if (command !== "resume") {
      for (const row of study.rows) { const run = this.get(row.runId); if (!terminal.has(run.status)) this.control(run.id, command); }
    } else if (!this.studyJobs.has(id)) {
      const job = Promise.resolve().then(() => this.driveStudy(id)).finally(() => {
        this.studyJobs.delete(id);
        if (!this.closing && this.getStudy(id).status === "running") this.studyControl(id, "resume");
      });
      this.studyJobs.set(id, job);
    }
  }
  private async driveStudy(id: string): Promise<void> {
    for (const row of this.getStudy(id).rows) {
      if (this.closing || this.getStudy(id).status !== "running") return;
      const run = this.get(row.runId); if (terminal.has(run.status)) continue;
      this.control(run.id, "resume");
      // Wait for this whole branch before starting the next; errors remain in the batch.
      while (this.get(row.runId).status === "running") {
        const job = this.jobs.get(row.runId);
        if (job) await job.promise;
        else await new Promise(resolve => setTimeout(resolve, 100));
        if (this.closing || this.getStudy(id).status !== "running") return;
      }
    }
    const study = this.getStudy(id); if (study.status === "running") { study.status = "completed"; this.store.saveStudy(study); }
  }
  exportRun(id: string) {
    const run = this.get(id);
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), run: this.snapshot(id, { owner: true, research: true }),
      memories: run.memories, sessions: run.sessions, cases: this.store.cases(id), checkpoints: this.store.checkpoints(id) };
  }
  stopAll(): void {
    this.closing = true;
    for (const id of this.jobs.keys()) this.control(id, "pause");
    for (const id of this.studyJobs.keys()) this.studyControl(id, "pause");
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.jobs.values()].map(j => j.promise).concat([...this.studyJobs.values()])); }
  async waitForRun(id: string): Promise<void> { const job = this.jobs.get(id); if (job) await job.promise; else await new Promise(resolve => setTimeout(resolve, 50)); }
}

function summary(run: StoredPartnerRun): RunSummary {
  return { id: run.id, title: run.title, status: run.status, mode: run.spec.mode, mechanism: run.spec.mechanism ?? "full", protocol: run.spec.protocol ?? "legacy-v8", createdAt: run.createdAt,
    round: run.world.round, maxRounds: run.world.maxRounds, revision: run.world.revision, phase: run.world.phase,
    actors: actorIds.map(id => ({ id, name: run.world.actors[id].name, kind: run.world.actors[id].kind })), parentId: run.parentId, studyId: run.studyId, condition: run.condition };
}
function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : "Agent 调用失败，世界保持在原检查点").replace(/\bsk-[\w-]+/g, "[redacted]").replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]").slice(0, 500);
}
