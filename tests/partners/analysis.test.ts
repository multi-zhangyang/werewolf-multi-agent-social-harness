import { describe, expect, it } from "vitest";
import { analyzeStudy, type StudyAnalysisRun } from "../../src/partners/analysis";
import type { StudyRow, StudyView } from "../../src/partners/api-types";
import type { Action, WorldState } from "../../src/partners/contracts";
import { createMind } from "../../src/partners/mind";
import { applyAction, createWorld, currentActor } from "../../src/partners/world";

function step(world: WorldState, action: Action): WorldState {
  return applyAction(world, currentActor(world)!, action, `cmd:${world.revision + 1}`);
}

function branch(id: string, options: {
  condition?: StudyRow["condition"]; returned?: number; investment?: number; roundTwoInvestment?: number;
  stopAt?: "before-offer" | "after-settle" | "after-repair"; exit?: boolean; claimedIncome?: number;
} = {}): StudyAnalysisRun {
  let world = createWorld({ maxRounds: 3, actors: {
    a: { name: "甲", kind: "ai", productivity: 3, burden: 0 },
    b: { name: "乙", kind: "ai", productivity: 3, burden: 0 },
  } }, id);
  world = step(world, { type: "offer", promiseRatio: 0.5, collateral: 0 });
  world = step(world, { type: "invest", amount: 6 });
  world = step(world, { type: "settle", returnAmount: 0 });
  world = step(world, { type: "repair", compensation: options.condition === "compensation" ? 9 : 0,
    ...(options.condition && options.condition !== "none" ? { message: "对不起。" } : {}) });
  world = step(world, { type: "respond", choice: "continue" });
  const result = () => ({ world, minds: { a: createMind("a", "目标"), b: createMind("b", "目标") } });
  if (options.stopAt === "before-offer") return result();
  world = step(world, { type: "offer", promiseRatio: 0.5, collateral: 0, intent: "先承诺一半，按实际处境决定返还。" });
  world = step(world, { type: "invest", amount: options.roundTwoInvestment ?? 6 });
  world = step(world, { type: "settle", returnAmount: options.returned ?? 6,
    ...(options.claimedIncome === undefined ? {} : { claimedIncome: options.claimedIncome }), intent: "保留资金，暂时不公开实际到账。" });
  if (options.stopAt === "after-settle") return result();
  world = step(world, { type: "repair", compensation: 0 });
  if (options.stopAt === "after-repair") return result();
  world = step(world, { type: "respond", choice: options.exit ? "exit" : "continue" });
  if (options.exit) return result();
  world = step(world, { type: "offer", promiseRatio: 0.5, collateral: 0 });
  world = step(world, { type: "invest", amount: options.investment ?? 6 });
  world = step(world, { type: "settle", returnAmount: 0 });
  world = step(world, { type: "repair", compensation: 0 });
  world = step(world, { type: "respond", choice: "continue" });
  return result();
}

function row(runId: string, patch: Partial<StudyRow> = {}): StudyRow {
  // Stale presentation values must never become observations.
  return { runId, condition: "none", agreeableness: 0.2, mechanism: "full", repeat: 0, status: "completed",
    returned: 999, compensation: 999, investment: 999, payoff: 999, durationMs: 0, ...patch };
}
function study(rows: StudyRow[]): StudyView {
  return { id: "study-analysis", status: "completed", createdAt: "2026-10-03T00:00:00Z",
    spec: { repeats: 5, agreeableness: [0.2, 0.8], mechanisms: ["full", "no-inertia", "no-mind"], maxRounds: 3, seed: 17 },
    total: rows.length, completed: rows.filter(row => row.status === "completed").length,
    failed: rows.filter(row => row.status === "failed").length, note: "fixture", rows };
}

describe("Partners exploratory study analysis", () => {
  it("uses actual legal events, keeps failed partial observations, and never converts missing behavior into zero", () => {
    const failed = branch("failed", { stopAt: "after-settle", returned: 6 });
    const waiting = branch("waiting", { stopAt: "before-offer" });
    const finished = branch("finished", { returned: 0, investment: 0 });
    const report = analyzeStudy(study([
      row("failed", { status: "failed", error: "provider timeout" }), row("waiting", { status: "paused" }), row("finished"),
      row("missing", { status: "failed" }),
    ]), [finished, waiting, failed]);
    expect(report.branches[0].metrics).toMatchObject({ returned: 6, returnRatio: 1 / 3, compensation: null, investment: null, payoff: null });
    expect(report.branches[1].metrics.promiseRatio).toBeNull();
    expect(report.branches[1].metrics.compensation).toBeNull();
    expect(report.branches[2].metrics).toMatchObject({ returned: 0, returnRatio: 0, compensation: 0, investment: 0 });
    expect(report.branches[3].worldAvailable).toBe(false);
    expect(report.totals).toMatchObject({ rows: 4, worldsAvailable: 3, statuses: { failed: 2, completed: 1, paused: 1 } });
    expect(report.groups[0].metrics.returned).toMatchObject({ n: 2, missing: 2, values: [6, 0], mean: 3, median: 3, range: [0, 6] });
    expect(report.groups[0].metrics.compensation).toMatchObject({ n: 1, missing: 3, values: [0], mean: 0, ci95: null, uncertainty: "insufficient" });
    expect(report.branches[0].error).toBe("provider timeout");
  });

  it("leaves a zero-income return ratio unscored while keeping the actual zero transfer", () => {
    const run = branch("zero", { roundTwoInvestment: 0, returned: 0 });
    const report = analyzeStudy(study([row("zero")]), [run]);
    expect(report.branches[0].metrics.returned).toBe(0);
    expect(report.branches[0].metrics.returnRatio).toBeNull();
    expect(report.branches[0].missingReasons.returnRatio).toContain("实际到账为 0");
    expect(report.groups[0].metrics.returnRatio).toMatchObject({ n: 0, missing: 1, mean: null, ci95: null });
  });

  it("does not treat an exited third-round investment opportunity as zero investment", () => {
    const run = branch("exit", { exit: true });
    const report = analyzeStudy(study([row("exit")]), [run]);
    expect(report.branches[0].metrics.investment).toBeNull();
    expect(report.branches[0].metrics.payoff).not.toBeNull();
    expect(report.branches[0].metrics.compensation).toBe(0);
  });

  it("pairs repair contrasts by repeat, personality and mechanism with deterministic bootstrap intervals", () => {
    const rows = [row("n0"), row("a0", { condition: "apology" }), row("n1", { repeat: 1 }), row("a1", { repeat: 1, condition: "apology" }),
      row("high", { condition: "apology", agreeableness: 0.8 }), row("off", { condition: "apology", mechanism: "no-mind" })];
    const runs = [branch("n0", { returned: 2 }), branch("a0", { returned: 4 }), branch("n1", { returned: 6 }), branch("a1", { returned: 10 }),
      branch("high", { returned: 12 }), branch("off", { returned: 8 })];
    const report = analyzeStudy(study(rows), runs);
    const effect = report.pairedRepairEffects.find(effect => effect.treatment === "apology" && effect.agreeableness === 0.2 && effect.mechanism === "full")!;
    expect(effect).toMatchObject({ repeatKeys: 2, matchedBranchPairs: 2, ambiguousRepeatKeys: 0 });
    expect(effect.metrics.returned).toMatchObject({ n: 2, values: [2, 4], mean: 3, median: 3, range: [2, 4], ci95: [2, 4], uncertainty: "bootstrap" });
    expect(effect.metrics.returned.cohensDz).toBeCloseTo(3 / Math.sqrt(2));
    expect(effect.metrics.returned.pairs.map(pair => pair.repeat)).toEqual([0, 1]);
    expect(report.pairedRepairEffects.find(effect => effect.agreeableness === 0.8 && effect.treatment === "apology")?.metrics.returned).toMatchObject({ n: 0, mean: null, ci95: null, uncertainty: "insufficient" });
    expect(analyzeStudy(study(rows), runs)).toEqual(report);
    expect(report.groupContrasts.some(contrast => contrast.factor === "agreeableness" && contrast.metrics.returned.meanDifference !== null)).toBe(true);
    expect(report.groupContrasts.some(contrast => contrast.factor === "mechanism" && contrast.treatment === "no-mind")).toBe(true);
  });

  it("excludes missing paired outcomes and makes the insufficient-sample limit explicit", () => {
    const report = analyzeStudy(study([
      row("n0"), row("c0", { condition: "compensation" }), row("n1", { repeat: 1 }), row("c1", { condition: "compensation", repeat: 1, status: "failed" }),
    ]), [branch("n0", { returned: 3 }), branch("c0", { condition: "compensation", returned: 9 }), branch("n1", { returned: 6 }), branch("c1", { condition: "compensation", stopAt: "before-offer" })]);
    const metric = report.pairedRepairEffects.find(effect => effect.treatment === "compensation")!.metrics.returned;
    expect(metric).toMatchObject({ n: 1, missing: 1, mean: 6, ci95: null, cohensDz: null, uncertainty: "insufficient" });
    expect(metric.pairs).toHaveLength(1);
  });

  it("flags ambiguous duplicate pairs and world records instead of selecting an arbitrary sample", () => {
    const run = branch("n0");
    const report = analyzeStudy(study([row("n0"), row("nDuplicate"), row("a0", { condition: "apology" })]), [run, run, branch("nDuplicate"), branch("a0")]);
    expect(report.branches[0].dataIssues).toEqual(["duplicate_world"]);
    expect(report.branches[0].worldAvailable).toBe(false);
    expect(report.pairedRepairEffects.find(effect => effect.treatment === "apology")).toMatchObject({ ambiguousRepeatKeys: 1, matchedBranchPairs: 0 });
  });

  it("reports factual claims and contemporaneous intent with later mind revisions distinguished", () => {
    const run = branch("audit", { returned: 0, claimedIncome: 5 });
    const settlement = run.world.events.find(event => event.kind === "settlement" && event.round === 2)!;
    run.minds.a.changes = [
      { revision: settlement.revision - 1, version: 1, eventId: "prior", sourceIds: [], reason: "我打算保留资源" },
      { revision: settlement.revision, version: 2, eventId: settlement.id, sourceIds: [settlement.id], reason: "结算后重新考虑" },
    ];
    const report = analyzeStudy(study([row("audit")]), [run]);
    const audit = report.branches[0].audit.find(audit => audit.round === 2)!;
    expect(audit).toMatchObject({ actorId: "a", actualIncome: 18, claimedIncome: 5, claimedMinusActual: -13, returned: 0, breachVerdict: true, experimentalSetup: false });
    expect(audit.priorIntentDeclarations.map(item => item.actionType)).toEqual(["offer", "settle"]);
    expect(audit.mindRevisionsBeforeAction.map(change => change.reason)).toEqual(["我打算保留资源"]);
    expect(audit.mindRevisionsAfterAction.map(change => change.reason)).toEqual(["结算后重新考虑"]);
    expect(report.branches[0].audit[0].experimentalSetup).toBe(true);
    expect(audit).not.toHaveProperty("deception");
    expect(audit).not.toHaveProperty("retaliation");
    expect(report.notes.join(" ")).toContain("没有操控客观履约能力冲击");
  });

  it("counts prediction statuses separately and recomputes Brier only from verifiable scored events", () => {
    const run = branch("predictions");
    const event = run.world.events.find(event => event.kind === "investment" && event.round === 2)!;
    const common = { targetActorId: "b" as const, round: 2, action: "invest" as const, metric: "amount" as const, threshold: 6, probability: 0.8,
      id: "p", createdRevision: event.revision - 1, sourceIds: [] };
    run.minds.a.predictions = [
      { ...common, id: "verified", status: "scored", evidenceId: event.id, brier: 0.99, outcome: false },
      { ...common, id: "invalid", status: "scored", evidenceId: "missing", brier: 0 },
      { ...common, id: "pending", status: "pending" },
      { ...common, id: "unscored", status: "unscored", reason: "机会未发生" },
    ];
    const report = analyzeStudy(study([row("predictions")]), [run]);
    expect(report.predictions).toMatchObject({ scored: 2, invalidScored: 1, pending: 1, unscored: 1, brier: { n: 1, missing: 1, ci95: null } });
    expect(report.predictions.brier.mean).toBeCloseTo(0.04);
  });

  it("returns JSON-safe empty results and preserves input worlds and mind records", () => {
    const empty = analyzeStudy(study([]), []);
    expect(empty.groups).toEqual([]);
    expect(empty.pairedRepairEffects).toEqual([]);
    expect(empty.predictions.brier.mean).toBeNull();
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
    const run = branch("immutable"); const before = structuredClone(run);
    const report = analyzeStudy(study([row("immutable", { mechanism: "no-mind" })]), [run]);
    expect(report.branches[0].subjectiveJudgments).toBeNull();
    expect(run).toEqual(before);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
