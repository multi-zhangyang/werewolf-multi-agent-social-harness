import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { replayDecisionCase } from "../src/runtime/replay-case";
import { loadRegistry } from "../src/society/models/registry";
import { sourceHash, type DecisionCase } from "../src/runtime/cases";

// Original database is read-only; no tool executor is constructed.
const option = (name: string, fallback = "") => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const directory = option("output", `data/replay-cases-${Date.now()}`);
if (existsSync(directory)) throw new Error("输出目录已存在；请另选目录，保留先前复测");
const db = new Database(option("database"), { readonly: true });
const originals = option("cases").split(",").map(id => {
  const row = db.prepare("select document from decision_cases where id=?").get(id) as { document: string } | undefined;
  if (!row) throw new Error(`案例不存在：${id}`);
  return JSON.parse(row.document) as DecisionCase;
});
db.close();
const registry = loadRegistry();
mkdirSync(directory, { recursive: true });
const choices = option("tool-choice") === "compare" ? [false, true] : [false];
const jobs = Array.from({ length: Number(option("repeats", "2")) }, (_, repeat) => originals.flatMap((record, i) => ((i + repeat) % 2 ? choices.toReversed() : choices).map(forceSingleTool => ({ record, repeat, forceSingleTool })))).flat();
writeFileSync(`${directory}/manifest.json`, JSON.stringify({ sourceHash: sourceHash(), createdAt: new Date().toISOString(), trials: jobs.map(j => ({ caseId: j.record.id, repeat: j.repeat, forceSingleTool: j.forceSingleTool })) }, null, 2));
const results: unknown[] = [];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (jobs.length) {
    const job = jobs.shift()!;
    const replay = await replayDecisionCase(job.record, registry, job.forceSingleTool ? { forceSingleTool: true } : {});
    writeFileSync(`${directory}/${replay.id}.json`, JSON.stringify(replay, null, 2));
    const response = replay.response as any;
    const request = (replay.providerRequest ?? replay.request) as any;
    const calls = response?.output?.filter((item: any) => item.type === "function_call") ?? [];
    const validation = calls.map((call: any) => {
      const schema = request.tools.find((t: any) => t.name === call.name)?.parameters;
      try { return { name: call.name, valid: Boolean(schema) && z.fromJSONSchema(schema).safeParse(JSON.parse(call.arguments)).success }; }
      catch { return { name: call.name, valid: false }; }
    });
    const result = { id: replay.id, originCaseId: job.record.id, repeat: job.repeat, forceSingleTool: job.forceSingleTool, error: replay.error, durationMs: replay.durationMs, usage: response?.usage, toolValidation: validation, schemaValid: validation.length > 0 && validation.every((v: any) => v.valid) };
    results.push(result); writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
  }
}));
