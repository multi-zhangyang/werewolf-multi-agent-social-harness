import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PartnerStore } from "../../src/partners/store";
import { PartnerService, type PartnerFactory } from "../../src/partners/service";
import { InterventionService } from "../../src/partners/interventions";
import { interventionSpecSchema } from "../../src/partners/intervention-types";
import { PartnerDecisionError } from "../../src/partners/agent";
import { assertConservation } from "../../src/partners/world";
import { fixtureDecision, fixtureParticipant } from "./fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness(factory: PartnerFactory = fixtureParticipant) {
  const db = new Database(":memory:"); const store = new PartnerStore(db); const partners = new PartnerService(store, factory); const service = new InterventionService(partners);
  cleanups.push(async () => { service.stopAll(); partners.stopAll(); await service.settled(); await partners.settled(); db.close(); });
  return { service, partners, store };
}
const spec = (overrides: Record<string, unknown> = {}) => interventionSpecSchema.parse({ repeats: 1, ...overrides });
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 3)); }
}

describe("Same-checkpoint psychological interventions", () => {
  it("preregisters independent injected checkpoints and execution order before any model call", () => {
    let calls = 0;
    const { service, partners, store } = harness(() => ({ configuration: { fixture: true }, async decide(input) { calls++; return fixtureDecision(input); } }));
    const { experiment } = service.create(spec());
    expect(calls).toBe(0); expect(experiment.total).toBe(4);
    const source = store.getCheckpoint(experiment.checkpointId)!;
    expect(source.state.world.deal).toMatchObject({ promiseRatio: 0.5, investment: 6, returned: 0, compensation: 0 });
    const fingerprint = JSON.stringify(source);
    for (const row of experiment.rows) {
      const run = partners.get(row.runId); const injected = store.getCheckpoint(`${run.id}:${source.revision}`)!;
      expect({ ...run.world, id: source.state.world.id }).toEqual(source.state.world);
      expect(run.memories).toEqual(source.state.memories);
      expect(run.minds.a.relationship).toEqual({ ...source.state.minds.a.relationship, willingness: row.value });
      expect(run.minds.b).toEqual(source.state.minds.b);
      expect(injected.state.minds.a.relationship.willingness).toBe(row.value);
      expect(store.getCheckpoint(`${run.id}:3`)?.state.minds.a.relationship.willingness).toBe(source.state.minds.a.relationship.willingness);
      expect(run.spec.protocol).toBe("responses-v1"); assertConservation(run.world);
    }
    expect(JSON.stringify(store.getCheckpoint(experiment.checkpointId))).toBe(fingerprint);
    const second = service.create(spec());
    expect(second.experiment.rows.map(row => [row.value, row.mechanism, row.repeat])).toEqual(experiment.rows.map(row => [row.value, row.mechanism, row.repeat]));
  });
  it("commits exactly one activation per single-decision trial, leaves source immutable, and exports missing outcomes", async () => {
    const { service, partners, store } = harness();
    const { experiment } = service.create(spec()); const source = JSON.stringify(partners.exportRun(experiment.sourceRunId));
    service.control(experiment.id, "resume"); await service.settled();
    const result = service.view(experiment.id);
    expect(result).toMatchObject({ status: "completed", total: 4, completed: 4, failed: 0 });
    for (const row of result.rows) {
      expect(row.runStatus).toBe("paused"); expect(row.action?.type).toBe("respond");
      expect(partners.get(row.runId).world.revision).toBe(row.sourceRevision + 1);
      expect(store.cases(row.runId)).toHaveLength(1); expect(row.payoff).toBeNull();
    }
    const exported = service.export(experiment.id);
    expect(exported.analysis.paired.every(group => group.matched === 1 && group.actionChanged.ci95 === null)).toBe(true);
    expect(exported.analysis.groups.every(group => group.payoff.n === 0 && group.payoff.missing === 1)).toBe(true);
    // Ignore only the export clock; original world, minds, cases and checkpoints are unchanged.
    const original = JSON.parse(source); const current = partners.exportRun(experiment.sourceRunId);
    expect({ ...current, exportedAt: original.exportedAt }).toEqual(original);
  });
  it("retains failed samples and never automatically reruns a failed branch", async () => {
    let calls = 0;
    const { service, store } = harness(() => ({ configuration: { fixture: true }, async decide(input) {
      calls++; const result = fixtureDecision(input);
      if (input.mind!.relationship.willingness < 0.5) {
        result.decisionCase.status = "failed"; result.decisionCase.error = "fixture failure"; result.decisionCase.failures = 1;
        throw new PartnerDecisionError("fixture failure", result.decisionCase);
      }
      return result;
    } }));
    const { experiment } = service.create(spec()); service.control(experiment.id, "resume"); await service.settled();
    expect(service.view(experiment.id)).toMatchObject({ completed: 2, failed: 2, status: "completed" });
    expect(service.analysis(experiment.id).paired.every(pair => pair.missing === 1)).toBe(true);
    service.control(experiment.id, "resume"); await service.settled(); expect(calls).toBe(4);
    expect(experiment.rows.every(row => store.cases(row.runId).length === 1)).toBe(true);
  });
  it("recovers a persisted batch without repeating an activation committed before restart", async () => {
    const { service, store, partners } = harness();
    const { experiment } = service.create(spec()); const first = experiment.rows[0];
    partners.control(first.runId, "step"); await partners.settled();
    const batch = service.get(experiment.id); batch.status = "running"; store.saveIntervention(batch); store.recover();
    expect(service.get(experiment.id).status).toBe("paused");
    service.control(experiment.id, "resume"); await service.settled();
    expect(service.view(experiment.id).completed).toBe(4);
    expect(store.cases(first.runId)).toHaveLength(1);
  });
  it("stops an in-flight batch with no leaked staged action and exposes stopped unattempted rows", async () => {
    let entered = false;
    const { service, partners } = harness(() => ({ configuration: { fixture: true }, async decide(input) {
      entered = true; await new Promise(resolve => input.signal?.addEventListener("abort", resolve, { once: true })); return fixtureDecision(input);
    } }));
    const { experiment } = service.create(spec()); service.control(experiment.id, "resume"); await until(() => entered);
    service.control(experiment.id, "stop"); await service.settled();
    expect(service.view(experiment.id).status).toBe("stopped");
    expect(service.view(experiment.id).rows.some(row => row.status === "stopped")).toBe(true);
    expect(experiment.rows.every(row => partners.get(row.runId).world.revision === row.sourceRevision)).toBe(true);
  });
  it("does not take over a human seat or accept a foreign checkpoint", () => {
    const { partners, service } = harness();
    const human = partners.create({ mode: "human", autoStart: false }); const other = partners.create({ mode: "observe", autoStart: false });
    expect(() => service.create(spec({ sourceRunId: human.id, checkpointId: `${other.id}:0`, actorId: "b" }))).toThrow("不属于");
    expect(() => service.create(spec({ sourceRunId: human.id, checkpointId: `${human.id}:0`, actorId: "a" }))).toThrow("合法机会");
    expect(() => service.create(spec({ sourceRunId: human.id, checkpointId: `${human.id}:0`, actorId: "b", horizon: "game" }))).toThrow("两个 AI");
  });
  it("preserves historical labels while all resumed activations use the new SDK executor", async () => {
    const protocols: unknown[] = [];
    const { partners, store } = harness((_mechanism, protocol) => { protocols.push(protocol); return fixtureParticipant(); });
    const current = partners.create({ mode: "human", autoStart: false }); partners.control(current.id, "step"); await partners.settled();
    const legacy = partners.create({ mode: "human", autoStart: false }); const run = partners.get(legacy.id); delete run.spec.protocol; store.save(run);
    partners.control(legacy.id, "step"); await partners.settled();
    expect(protocols).toEqual(["responses-v1", "responses-v1"]);
    expect(partners.get(legacy.id).spec.protocol).toBeUndefined();
  });
});
