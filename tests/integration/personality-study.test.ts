import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runSpecSchema } from "../../src/runtime/types";

it("keeps personality conditions separate and pairs their public transcripts for blind review", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "society-personality-study-"));
  try {
    const rows = (["full", "persona-only"] as const).map(personality => ({ id: personality, scenario: "trust-game", index: 0, status: personality === "full" ? "completed" : "incomplete", messages: 1, meanLatencyMs: 0, inputTokens: 0, outputTokens: 0, errors: [], spec: runSpecSchema.parse({ scenario: "trust-game", roster: [{ characterId: "a" }, { characterId: "b" }], experiment: { personality } }) }));
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ sourceHash: "synthetic-test" }));
    writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(rows));
    for (const row of rows) writeFileSync(path.join(directory, `${row.id}.json`), JSON.stringify({ characters: [{ id: "a", name: "人物" }], events: [{ type: "message", actorId: "a", visibility: "public", text: row.id }, { type: "message", actorId: "a", visibility: ["a"], text: "private-sentinel" }] }));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/study.ts", "--analyze-only", `--output=${directory}`], { encoding: "utf8", timeout: 15000 });
    const pairs = JSON.parse(readFileSync(path.join(directory, "blind-pairs.json"), "utf8"));
    const keys = JSON.parse(readFileSync(path.join(directory, "pair-key.json"), "utf8"));
    const summary = JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8"));
    expect(pairs).toHaveLength(1); expect(keys).toHaveLength(1);
    expect(new Set([keys[0].A, keys[0].B])).toEqual(new Set(["full", "persona-only"]));
    expect(pairs[0].A[0].text).toBe(keys[0].A); expect(pairs[0].B[0].text).toBe(keys[0].B);
    expect(JSON.stringify(pairs)).not.toContain("private-sentinel");
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.reduce((n: number, group: { failures: unknown[] }) => n + group.failures.length, 0)).toBe(1);
  } finally {
    if (path.dirname(directory) === tmpdir()) rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("pairs psychology on/off only within matching personality and game rules", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "society-psychology-study-"));
  try {
    const conditions = [
      { personality: "full", psychology: "appraisal", trustProtocol: "pledge-repair" },
      { personality: "full", psychology: "off", trustProtocol: "pledge-repair" },
      { personality: "persona-only", psychology: "appraisal", trustProtocol: "pledge-repair" },
      { personality: "persona-only", psychology: "off", trustProtocol: "pledge-repair" },
      { personality: "full", psychology: "off", trustProtocol: "classic" },
    ];
    const rows = conditions.map((c, i) => ({ id: `r${i}`, scenario: "trust-game", index: 0, status: "completed", messages: 1, meanLatencyMs: 0, inputTokens: 0, outputTokens: 0, errors: [], spec: runSpecSchema.parse({ scenario: "trust-game", trustProtocol: c.trustProtocol, roster: [{ characterId: "a" }, { characterId: "b" }], experiment: { personality: c.personality, psychology: c.psychology } }) }));
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ sourceHash: "synthetic-test" }));
    writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(rows));
    for (const row of rows) writeFileSync(path.join(directory, `${row.id}.json`), JSON.stringify({ characters: [{ id: "a", name: "人物" }], events: [{ type: "message", actorId: "a", visibility: "public", text: row.id }] }));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/study.ts", "--analyze-only", `--output=${directory}`], { encoding: "utf8", timeout: 15000 });
    const keys = JSON.parse(readFileSync(path.join(directory, "pair-key.json"), "utf8"));
    const summary = JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8"));
    expect(keys.filter((k: { axis: string }) => k.axis === "psychology")).toHaveLength(2);
    expect(keys.filter((k: { axis: string }) => k.axis === "personality")).toHaveLength(2);
    expect(keys.some((k: { runA: string; runB: string }) => k.runA === "r4" || k.runB === "r4")).toBe(false);
    expect(summary.groups).toHaveLength(5);
  } finally { if (path.dirname(directory) === tmpdir()) rmSync(directory, { recursive: true, force: true }); }
}, 20000);
