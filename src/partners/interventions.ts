import { createHash, randomUUID } from "node:crypto";
import { actionSignature } from "./cognition";
import { distribution } from "./analysis";
import { applyAction, currentActor } from "./world";
import { PartnerError, type PartnerService } from "./service";
import { hashToken, type StoredPartnerRun } from "./store";
import { interventionSpecSchema, type InterventionAnalysis, type InterventionSpec, type InterventionView, type StoredIntervention } from "./intervention-types";

export const interventionNote = "从同一检查点复制世界、人格、私有目标和记忆，只对指定人物的一项关系估计做数值干预。这是外部心理干预，不是自然形成的信任。完整机制可以重新评价该估计；只记录心理的对照先隔离决定行动，之后另行记录心理。随机种子只决定运行顺序，不控制模型采样。";

/** Coordinates independent, persisted branches through the same rules and commit path as play. */
export class InterventionService {
  private jobs = new Map<string, Promise<void>>();
  private closing = false;
  constructor(readonly partners: PartnerService) {}
  get store() { return this.partners.store; }
  get(id: string) { const batch = this.store.getIntervention(id); if (!batch) throw new PartnerError("心理干预实验不存在", 404); return batch; }
  list() { return this.store.interventions().map(batch => this.view(batch.id)); }
  create(raw: InterventionSpec) {
    const spec = interventionSpecSchema.parse(raw); const ownerToken = randomUUID();
    return this.store.transact(() => {
      let sourceRunId = spec.sourceRunId; let checkpointId = spec.checkpointId;
      if (!sourceRunId) {
        if (spec.actorId !== "a") throw new PartnerError("内置失约情境的当前决策者为人物 a；其他人物请使用其合法机会的检查点");
        const created = this.partners.create({ mode: "observe", mechanism: "full", protocol: "responses-v1", maxRounds: 3, seed: spec.seed, autoStart: false },
          { maxRounds: 3, seed: spec.seed, actors: { a: { name: "林舟", kind: "ai", agreeableness: 0.5, productivity: 3 }, b: { name: "沈言", kind: "ai", agreeableness: 0.5, productivity: 3 } } });
        const source = this.partners.get(created.id);
        source.hidden = true; source.ownerHash = hashToken(ownerToken);
        source.experimentNote = "实验设置：承诺返还一半、投资 6、实际到账 18、返还 0、不道歉且补偿 0；后续行动由模型选择。";
        source.world = applyAction(source.world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "setup:offer");
        this.store.checkpoint(source);
        source.world = applyAction(source.world, "a", { type: "invest", amount: 6 }, "setup:invest");
        this.store.checkpoint(source);
        source.world = applyAction(source.world, "b", { type: "settle", returnAmount: 0 }, "setup:betrayal");
        this.store.checkpoint(source);
        source.world = applyAction(source.world, "b", { type: "repair", compensation: 0 }, "setup:no-repair");
        source.version++; this.store.save(source); this.store.checkpoint(source);
        sourceRunId = source.id; checkpointId = `${source.id}:${source.world.revision}`;
      }
      const source = this.partners.get(sourceRunId); const checkpoint = this.store.getCheckpoint(checkpointId!);
      if (!checkpoint || checkpoint.runId !== source.id) throw new PartnerError("检查点不属于原局", 404);
      if (currentActor(checkpoint.state.world) !== spec.actorId || checkpoint.state.world.actors[spec.actorId].kind !== "ai")
        throw new PartnerError("只能干预当前拥有合法机会的 AI 人物，不能替换人类席位", 409);
      if (spec.horizon === "game" && Object.values(checkpoint.state.world.actors).some(actor => actor.kind === "human"))
        throw new PartnerError("整局观察需要两个 AI 席位；含人类的检查点可以观察单次决策", 409);
      const batch: StoredIntervention = { id: randomUUID(), createdAt: new Date().toISOString(), ownerHash: hashToken(ownerToken), status: "paused", spec,
        sourceRunId: source.id, checkpointId: checkpoint.id, sourceHash: createHash("sha256").update(JSON.stringify(checkpoint.state)).digest("hex"),
        rows: [], note: `${source.hidden ? source.experimentNote + " " : "前段来自原局的真实检查点。 "}${interventionNote}` };
      for (let repeat = 0; repeat < spec.repeats; repeat++) for (const mechanism of spec.mechanisms) for (const value of spec.values) {
        const run: StoredPartnerRun = { ...structuredClone(source), ...structuredClone(checkpoint.state), id: randomUUID(), title: `心理干预 · ${spec.construct === "willingness" ? "合作意愿" : "履约能力"} ${value}`,
          createdAt: batch.createdAt, version: 1, status: "paused", ownerHash: batch.ownerHash, playerHashes: {}, activities: [],
          parentId: source.id, checkpointId: checkpoint.id, hidden: false, interventionId: batch.id, experimentNote: batch.note,
          sessions: { a: [], b: [] } };
        delete run.error; delete run.activeActor; delete run.studyId; delete run.condition;
        run.world.id = run.id; run.spec = { ...run.spec, mechanism, protocol: "responses-v1", autoStart: false };
        const mind = run.minds[spec.actorId]; const before = mind.relationship[spec.construct]; const previousMindVersion = mind.version;
        mind.relationship[spec.construct] = value; mind.version++; mind.schemaVersion = 2;
        const manipulation = { path: `minds.${spec.actorId}.relationship.${spec.construct}`, before, after: value, previousMindVersion, mindVersion: mind.version };
        // Save the injected checkpoint itself, so case replay reproduces the treatment, not the source mind.
        this.store.save(run); this.store.inheritCheckpoints(source.id, run, checkpoint.revision); this.store.checkpoint(run);
        batch.rows.push({ runId: run.id, value, mechanism, repeat, sourceRevision: run.world.revision, manipulation });
      }
      let random = spec.seed >>> 0;
      for (let i = batch.rows.length - 1; i > 0; i--) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const j = random % (i + 1); [batch.rows[i], batch.rows[j]] = [batch.rows[j], batch.rows[i]]; }
      this.store.saveIntervention(batch);
      return { experiment: this.view(batch.id), ownerToken };
    });
  }
  view(id: string): InterventionView {
    const batch = this.get(id);
    const rows = batch.rows.map(row => {
      const run = this.partners.get(row.runId); const cases = this.store.decisionSummaries(run.id);
      const decision = cases.find(record => record.actorId === batch.spec.actorId && record.revision === row.sourceRevision);
      const committed = decision?.status === "completed" && run.world.revision > row.sourceRevision;
      const status = batch.spec.horizon === "decision" && committed || run.status === "completed" ? "completed" as const
        : run.status === "failed" || decision?.status === "failed" ? "failed" as const : run.status === "stopped" ? "stopped" as const
        : run.status === "running" ? "running" as const : "pending" as const;
      const after = committed ? this.store.getCheckpoint(`${run.id}:${row.sourceRevision + 1}`) : undefined;
      const before = this.store.getCheckpoint(`${run.id}:${row.sourceRevision}`)!;
      const metrics = this.partners.metrics(run.id);
      return { ...row, status, runStatus: run.status, error: run.error ?? (decision?.status === "failed" ? decision.error : undefined),
        caseId: decision?.id, action: committed ? decision.action : undefined,
        decisionBelief: committed && row.mechanism === "full" ? (decision.actionMind ?? decision.preparation?.after ?? decision.before).relationship[batch.spec.construct] : null,
        shadowBelief: committed && row.mechanism === "record-only" ? decision.shadow?.after?.relationship[batch.spec.construct] ?? null : null,
        shadowFailed: decision?.shadow?.status === "failed",
        forecast: decision?.receipt?.predictionId ? run.minds[batch.spec.actorId].predictions.find(forecast => forecast.id === decision.receipt!.predictionId) : undefined,
        durationMs: metrics.durationMs, retries: metrics.retries, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens,
        immediateWalletChange: after ? after.state.world.actors[batch.spec.actorId].wallet - before.state.world.actors[batch.spec.actorId].wallet : null,
        payoff: run.world.phase === "finished" ? run.world.actors[batch.spec.actorId].wallet - run.world.actors[batch.spec.actorId].initialWallet : null };
    });
    return { id, createdAt: batch.createdAt, status: batch.status, spec: batch.spec, sourceRunId: batch.sourceRunId, checkpointId: batch.checkpointId,
      sourceHash: batch.sourceHash, note: batch.note, total: rows.length, completed: rows.filter(row => row.status === "completed").length,
      failed: rows.filter(row => row.status === "failed").length, stopped: rows.filter(row => row.status === "stopped").length,
      shadowFailures: rows.filter(row => row.shadowFailed).length, rows };
  }
  control(id: string, command: "pause" | "resume" | "stop") {
    const batch = this.get(id); if (batch.status === "stopped" || batch.status === "completed") return;
    batch.status = command === "resume" ? "running" : command === "pause" ? "paused" : "stopped"; this.store.saveIntervention(batch);
    if (command !== "resume") for (const row of this.view(id).rows) {
      if (row.status === "pending" || row.status === "running") this.partners.control(row.runId, command);
    }
    else if (!this.jobs.has(id) && !this.closing) {
      const job = Promise.resolve().then(() => this.drive(id)).finally(() => {
        this.jobs.delete(id);
        if (!this.closing && this.get(id).status === "running") this.control(id, "resume");
      }); this.jobs.set(id, job);
    }
  }
  private async drive(id: string) {
    for (const row of this.get(id).rows) {
      if (this.closing || this.get(id).status !== "running") return;
      const current = this.view(id).rows.find(item => item.runId === row.runId)!;
      if (["completed", "failed", "stopped"].includes(current.status)) continue;
      this.partners.control(row.runId, this.get(id).spec.horizon === "decision" ? "step" : "resume");
      while (this.partners.get(row.runId).status === "running") {
        await this.partners.waitForRun(row.runId);
        if (this.closing || this.get(id).status !== "running") return;
      }
    }
    const batch = this.get(id);
    if (batch.status === "running") { batch.status = "completed"; this.store.saveIntervention(batch); }
  }
  analysis(id: string): InterventionAnalysis {
    const view = this.view(id); const seed = view.spec.seed;
    const groups = view.spec.mechanisms.flatMap(mechanism => view.spec.values.map(value => {
      const rows = view.rows.filter(row => row.mechanism === mechanism && row.value === value);
      const counts = new Map<string, number>();
      for (const row of rows) if (row.action) { const signature = actionSignature(row.action); counts.set(signature, (counts.get(signature) ?? 0) + 1); }
      return { mechanism, value, total: rows.length, completed: rows.filter(row => row.status === "completed").length, failed: rows.filter(row => row.status === "failed").length,
        actions: [...counts].map(([action, count]) => ({ action, count })), walletChange: distribution(rows.flatMap(row => row.immediateWalletChange == null ? [] : [row.immediateWalletChange]), rows.length, seed),
        payoff: distribution(rows.flatMap(row => row.payoff == null ? [] : [row.payoff]), rows.length, seed) };
    }));
    const paired = view.spec.mechanisms.map(mechanism => {
      const pairs: InterventionAnalysis["paired"][number]["pairs"] = []; const differences: number[] = [];
      for (let repeat = 0; repeat < view.spec.repeats; repeat++) {
        const low = view.rows.find(row => row.mechanism === mechanism && row.repeat === repeat && row.value === view.spec.values[0]);
        const high = view.rows.find(row => row.mechanism === mechanism && row.repeat === repeat && row.value === view.spec.values[1]);
        if (!low?.action || !high?.action) continue;
        pairs.push({ repeat, lowRunId: low.runId, highRunId: high.runId, changed: actionSignature(low.action) !== actionSignature(high.action) });
        if (low.immediateWalletChange != null && high.immediateWalletChange != null) differences.push(high.immediateWalletChange - low.immediateWalletChange);
      }
      return { mechanism, matched: pairs.length, missing: view.spec.repeats - pairs.length, pairs,
        actionChanged: distribution(pairs.map(pair => Number(pair.changed)), view.spec.repeats, seed), walletDifference: distribution(differences, view.spec.repeats, seed) };
    });
    return { exploratory: true, actorId: view.spec.actorId, groups, paired,
      note: "行动差异包含模型采样波动。只有完整机制与输入隔离对照的分布、失败率及干预后实际采用的估计一起比较，才能讨论心理字段的影响。只记录心理发生在行动之后，不能解释行动成因；单次决策完成不代表整局完成。" };
  }
  export(id: string) {
    return { schemaVersion: 1, kind: "psychological-intervention", experiment: this.view(id), analysis: this.analysis(id),
      sourceCheckpoint: this.store.getCheckpoint(this.get(id).checkpointId), branches: this.get(id).rows.map(row => this.partners.exportRun(row.runId)) };
  }
  stopAll() { this.closing = true; for (const id of this.jobs.keys()) this.control(id, "pause"); }
  async settled() { await Promise.allSettled([...this.jobs.values()]); }
}
