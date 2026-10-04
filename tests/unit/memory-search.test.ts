import { expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { runSpecSchema, type Memory } from "../../src/runtime/types";

it("finds separate Chinese keywords from the failed recall and ranks coverage inside the authorized scope", () => {
  const store = new SocietyStore(":memory:");
  try {
    const spec = runSpecSchema.parse({ scenario: "trust-game", mode: "experiment", roster: [{ characterId: "self" }, { characterId: "peer" }] });
    store.create({ id: "r", spec, characters: [], status: "completed", createdAt: "", ownerHash: "", playerHashes: {} });
    const base: Memory = { id: "receipt", characterId: "self", runId: "r", kind: "experience", text: "林投资7点，陈返还15点，之后补偿2点。", sourceIds: ["actual-event"], about: ["peer"], at: "2026-10-03T00:00:00Z" };
    const note: Memory = { ...base, id: "opinion", kind: "note", text: "陈愿意合作。", sourceIds: ["opinion-event"], at: "2026-10-03T00:01:00Z" };
    const other = { ...base, id: "other-person", characterId: "peer" };
    const unauthorized = { ...base, id: "other-branch" };
    for (const m of [base, note, other, unauthorized]) store.addMemory(m);
    const allowed = [base, note, other];
    const before = structuredClone(allowed);
    const result = store.recall("self", allowed, "陈 林 第1轮 投资 返还 补偿");
    expect(result.map(m => m.id)).toEqual(["receipt", "opinion"]);
    expect(result[0]).toEqual(base);
    expect(allowed).toEqual(before);
    expect(store.recall("self", allowed, "投资 返还 承诺 80%", "peer")).toEqual([base]);
    expect(store.recall("self", allowed, "返还 补偿", "unrelated")).toEqual([]);
    expect(store.recall("self", allowed, "不存在的旧经历")).toEqual([]);
    expect(store.recall("self", allowed, '" OR NEAR(不存在)')).toEqual([]);
  } finally { store.close(); }
});
