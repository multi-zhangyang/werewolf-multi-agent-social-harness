import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PartnerStore } from "../../src/partners/store";
import { PartnerService, type PartnerFactory } from "../../src/partners/service";
import { applyAction, assertConservation } from "../../src/partners/world";
import { fixtureDecision, fixtureParticipant } from "./fixture";
import { PartnerDecisionError, type PartnerActivity, type PartnerDecisionInput, type PartnerDecisionResult } from "../../src/partners/agent";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness(factory: PartnerFactory = fixtureParticipant) {
  const db = new Database(":memory:"); const store = new PartnerStore(db); const service = new PartnerService(store, factory);
  cleanups.push(async () => { service.stopAll(); await service.settled(); db.close(); }); return service;
}
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw new Error("test wait timed out"); await new Promise(resolve => setTimeout(resolve, 2)); }
}
function activity(input: PartnerDecisionInput, kind: PartnerActivity["kind"], attempt = 1, tool?: string): PartnerActivity {
  const event: PartnerActivity = { id: `${input.world.id}:${input.world.revision}:${attempt}:${kind}`, actorId: input.actorId, kind, attempt,
    at: new Date().toISOString(), ...(tool ? { tool } : {}), ...(kind === "model_error" ? { message: "fixture model failure" } : {}) };
  input.onActivity?.(event);
  return event;
}
describe("Partners transactional orchestration", () => {
  it("keeps a broken research-stream subscriber from interrupting the actor or other readers", async () => {
    const service = harness(() => ({ configuration: {}, async decide(input) {
      activity(input, "model_start"); activity(input, "model_end"); return fixtureDecision(input);
    } }));
    const created = service.create({ mode: "human", maxRounds: 1, autoStart: false });
    let brokenCalls = 0; let received = 0;
    service.subscribeRuntime(created.id, () => { brokenCalls++; throw new Error("disconnected viewer"); });
    const unsubscribe = service.subscribeRuntime(created.id, items => { received += items.length; });
    service.control(created.id, "resume"); await service.waitForRun(created.id);
    expect(service.get(created.id)).toMatchObject({ status: "waiting-human", world: { revision: 1 } });
    expect(brokenCalls).toBe(1); expect(received).toBeGreaterThan(1);
    expect(service.store.cases(created.id)[0].status).toBe("completed"); unsubscribe();
  });
  it("finishes three rounds through actual player actions and resumes with role swaps", async () => {
    const service = harness(); const created = service.create({ mode: "human", maxRounds: 3 });
    while (service.get(created.id).status !== "completed") {
      await waitFor(() => ["waiting-human", "completed", "failed"].includes(service.get(created.id).status));
      const run = service.get(created.id); if (run.status === "completed") break;
      expect(run.status).toBe("waiting-human");
      const action = fixtureDecision({ world: run.world, actorId: "a" }).action;
      const request = { expectedRevision: run.world.revision, commandId: `player:${run.world.revision}`, action };
      service.humanAction(created.id, "a", request);
      const committedRevision = service.get(created.id).world.revision;
      service.humanAction(created.id, "a", request);
      expect(service.get(created.id).world.revision).toBe(committedRevision);
    }
    const final = service.get(created.id);
    expect(final.world.revision).toBe(15); expect(final.world.completedDeals).toHaveLength(3);
    expect(final.world.completedDeals.map(d => d.investor)).toEqual(["a", "b", "a"]);
    assertConservation(final.world);
    expect(service.store.checkpoints(created.id)).toHaveLength(16);
    expect(service.store.cases(created.id).every(c => c.status === "completed")).toBe(true);
  });
  it("discards in-flight action, mind and session atomically when paused", async () => {
    let release: ((value: PartnerDecisionResult) => void) | undefined;
    let result: PartnerDecisionResult | undefined;
    const service = harness(() => ({ configuration: {}, decide(input) {
      activity(input, "agent_start"); activity(input, "model_start");
      result = fixtureDecision(input); result.mind.privateGoal = "uncommitted";
      return new Promise(resolve => { release = resolve; });
    } }));
    const created = service.create({ mode: "observe" });
    await waitFor(() => Boolean(release)); service.control(created.id, "pause");
    expect(service.get(created.id).activities.every(item => item.status === "failed" && String(item.output).includes("未提交"))).toBe(true);
    expect(service.get(created.id).activeActor).toBeUndefined();
    release!(result!); await service.settled();
    expect(service.get(created.id).status).toBe("paused");
    expect(service.get(created.id).world.revision).toBe(0);
    expect(service.get(created.id).minds.b.privateGoal).not.toBe("uncommitted");
    expect(service.store.cases(created.id)[0]).toMatchObject({ status: "failed", error: "调用已取消，行动未提交" });
    expect(service.store.checkpoints(created.id)).toHaveLength(1);
  });
  it("closes failed retry attempts and final activation independently, preserving failures and committing once", async () => {
    let retriedActivities: ReturnType<PartnerService["get"]>["activities"] = [];
    const service = harness(() => ({ configuration: {}, async decide(input) {
      const trace = [activity(input, "agent_start"), activity(input, "model_start"), activity(input, "model_error"), activity(input, "retry", 2)];
      retriedActivities = service.get(input.world.id).activities;
      trace.push(activity(input, "agent_start", 2), activity(input, "model_start", 2), activity(input, "model_end", 2), activity(input, "tool_start", 2, "recall"));
      // An absent agent_end must not leave a spinner after commit deletes activeActor.
      const decision = fixtureDecision(input);
      decision.decisionCase.activities = trace;
      decision.decisionCase.retries = 1; decision.decisionCase.failures = 1;
      decision.decisionCase.exchanges = [{ attempt: 1, request: { fixture: true }, error: "fixture model failure", durationMs: 1, inputTokens: 0, outputTokens: 0 },
        { attempt: 2, request: { fixture: true }, response: { fixture: true }, durationMs: 1, inputTokens: 0, outputTokens: 0 }];
      return decision;
    } }));
    const created = service.create({ mode: "human", maxRounds: 1, autoStart: false });
    const priorFailure = fixtureDecision({ world: service.get(created.id).world, actorId: "b" }).decisionCase;
    priorFailure.status = "failed"; priorFailure.failures = 1; priorFailure.error = "earlier independent failure";
    service.store.saveCase(created.id, priorFailure);
    service.control(created.id, "resume");
    await waitFor(() => service.get(created.id).status === "waiting-human");
    const final = service.get(created.id);
    expect(retriedActivities.find(item => item.id.endsWith(":1:agent_start"))).toMatchObject({ status: "failed" });
    expect(String(retriedActivities.find(item => item.id.endsWith(":1:agent_start"))?.output)).toContain("未提交");
    expect(final.activities.find(item => item.id.endsWith(":1:agent_start"))?.status).toBe("failed");
    expect(final.activities.find(item => item.id.endsWith(":2:agent_start"))?.status).toBe("completed");
    expect(final.activities.find(item => item.name === "recall")).toMatchObject({ status: "failed", output: "行动已提交，但本模型或工具未报告结束，活动状态不完整" });
    expect(final.activities.every(item => item.status !== "running" && Boolean(item.finishedAt))).toBe(true);
    expect(final.activeActor).toBeUndefined();
    expect(final.world.revision).toBe(1);
    expect(final.world.commands).toHaveLength(1);
    expect(final.world.actors.b.wallet).toBe(16);
    assertConservation(final.world);
    const cases = service.store.cases(created.id);
    expect(cases).toHaveLength(2);
    expect(cases.find(item => item.id === priorFailure.id)).toEqual(priorFailure);
    expect(cases.find(item => item.status === "completed")).toMatchObject({ failures: 1, retries: 1 });
    while (service.get(created.id).status !== "completed") {
      const run = service.get(created.id);
      expect(run.status).toBe("waiting-human");
      service.humanAction(created.id, "a", { expectedRevision: run.world.revision, commandId: `human:${run.world.revision}`,
        action: fixtureDecision({ world: run.world, actorId: "a" }).action });
      await waitFor(() => ["waiting-human", "completed", "failed"].includes(service.get(created.id).status));
      expect(service.get(created.id).status).not.toBe("failed");
    }
    const completed = service.get(created.id);
    expect(completed.world.revision).toBe(5);
    expect(completed.activities.every(item => item.status !== "running")).toBe(true);
    expect(service.store.cases(created.id).find(item => item.id === priorFailure.id)).toEqual(priorFailure);
  });
  it("finishes a failed activation even without an agent_end callback and preserves its case", async () => {
    const service = harness(() => ({ configuration: {}, async decide(input) {
      activity(input, "agent_start"); activity(input, "model_start");
      const record = fixtureDecision(input).decisionCase;
      record.status = "failed"; record.failures = 1; record.error = "fixture activation failed";
      throw new PartnerDecisionError(record.error, record);
    } }));
    const created = service.create({ mode: "observe" });
    await waitFor(() => service.get(created.id).status === "failed");
    const final = service.get(created.id);
    expect(final.world.revision).toBe(0);
    expect(final.activeActor).toBeUndefined();
    expect(final.activities).toHaveLength(2);
    expect(final.activities.every(item => item.status === "failed" && String(item.output).includes("未提交"))).toBe(true);
    expect(service.store.cases(created.id)[0]).toMatchObject({ status: "failed", error: "fixture activation failed" });
  });
  it("does not close another actor or revision's activity when retrying or ending the current activation", async () => {
    const service = harness(() => ({ configuration: {}, async decide(input) {
      activity(input, "agent_start"); activity(input, "retry", 2); activity(input, "agent_start", 2);
      return fixtureDecision(input);
    } }));
    const created = service.create({ mode: "human", autoStart: false });
    const source = service.get(created.id);
    source.activities.push({ id: "different-revision", actorId: "b", revision: 1, name: "角色 Agent", status: "running", startedAt: new Date().toISOString() },
      { id: "different-actor", actorId: "a", revision: 0, name: "角色 Agent", status: "running", startedAt: new Date().toISOString() });
    service.store.save(source);
    service.control(created.id, "resume");
    await waitFor(() => service.get(created.id).status === "waiting-human");
    const final = service.get(created.id);
    expect(final.activities.filter(item => item.id.startsWith("different-"))).toEqual(source.activities);
    expect(final.activities.filter(item => item.actorId === "b" && item.revision === 0).every(item => item.status !== "running")).toBe(true);
  });
  it("forks independent legal repair conditions from one exact source checkpoint", () => {
    const service = harness(); const created = service.create({ mode: "observe", autoStart: false }); const source = service.get(created.id);
    source.world = applyAction(source.world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "setup1");
    source.world = applyAction(source.world, "a", { type: "invest", amount: 6 }, "setup2");
    source.world = applyAction(source.world, "b", { type: "settle", returnAmount: 0 }, "setup3");
    source.minds.a.plan = { aim: "保持条件", nextStep: "观察补偿", continueWhen: "得到补偿", reviseWhen: "说法改变", abandonWhen: "再次失约", status: "active", sourceIds: [source.world.events[0].id], revision: 3 };
    service.store.save(source); const checkpoint = service.store.checkpoint(source); const before = JSON.stringify(service.exportRun(source.id));
    const branches = ["none", "apology", "compensation"].map(kind => service.fork(source.id, { checkpointId: checkpoint.id, autoStart: false, intervention: { kind: kind as "none" | "apology" | "compensation", amount: 9 } }));
    expect(branches.map(b => service.get(b.id).world.deal.compensation)).toEqual([0, 0, 9]);
    const b0 = service.get(branches[0].id), b2 = service.get(branches[2].id);
    expect(b2.world.actors.a.wallet - b0.world.actors.a.wallet).toBe(9);
    expect(b2.minds).toEqual(b0.minds); expect(b2.memories).toEqual(b0.memories);
    b2.minds.a.privateGoal = "branch only"; service.store.save(b2);
    expect(service.get(source.id).minds.a.privateGoal).not.toBe("branch only");
    const after = service.exportRun(source.id); const original = JSON.parse(before); delete original.exportedAt;
    const withoutTime = { ...after } as Partial<typeof after>; delete withoutTime.exportedAt;
    expect(withoutTime).toEqual(original); branches.forEach(b => assertConservation(service.get(b.id).world));
  });
  it("persists all 90 preregistered branches, keeps failures and finishes a subset batch", async () => {
    const service = harness(() => ({ configuration: {}, async decide() { throw new Error("fixture provider failure"); } }));
    const big = service.createStudy({ repeats: 5, agreeableness: [0.2, 0.8], mechanisms: ["full", "no-inertia", "no-mind"], maxRounds: 3, seed: 7 });
    expect(big.study.total).toBe(90); expect(big.study.status).toBe("paused");
    expect(service.getStudy(big.study.id).rows).toHaveLength(90);
    const small = service.createStudy({ repeats: 1, agreeableness: [0.2], mechanisms: ["full"], maxRounds: 3, seed: 7 });
    service.studyControl(small.study.id, "resume");
    await waitFor(() => service.getStudy(small.study.id).status === "completed");
    expect(service.studyView(small.study.id)).toMatchObject({ completed: 0, failed: 3, total: 3 });
    expect(service.studyView(small.study.id).rows.every(r => r.error === "fixture provider failure")).toBe(true);
  });
  it("recovers interruption at the durable boundary without changing the world", () => {
    const service = harness(); const created = service.create({ mode: "observe", autoStart: false });
    const run = service.get(created.id); run.status = "running"; run.activeActor = "b"; service.store.save(run);
    const world = structuredClone(run.world); service.store.recover();
    expect(service.get(created.id)).toMatchObject({ status: "paused", world });
    expect(service.get(created.id).activeActor).toBeUndefined();
  });
});
