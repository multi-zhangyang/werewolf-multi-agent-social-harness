import Database from "better-sqlite3";
import { resolve } from "node:path";
import { SocietyStore } from "../src/runtime/store";
import type { StudyRecord } from "../src/runtime/studies";

const option = (name: string) => { const value = process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3); if (!value) throw new Error(`缺少 --${name}`); return value; };
const sourceFile = resolve(option("source")); const targetFile = resolve(option("target"));
if (sourceFile === targetFile) throw new Error("源库和目标库必须分开");
const source = new Database(sourceFile, { readonly: true });
const row = source.prepare("select document from studies where id=?").get(option("study")) as { document: string } | undefined;
if (!row) throw new Error("实验不存在");
const study = JSON.parse(row.document) as StudyRecord;
if (study.status !== "completed" || study.spec.kind === "free") throw new Error("仅支持已结束的独立受控实验；自由对局需保留其原数据库");
const results = source.prepare("select * from study_trials where study_id=?").all(study.id) as Array<{ id: string; study_id: string; document: string }>;
const ids = [...study.trials.map(t => t.id), ...(study.prefixes ?? []).map(p => p.caseRunId)];
const cases = ids.flatMap(id => source.prepare("select * from decision_cases where run_id=? order by rowid").all(id)) as Array<{ id: string; run_id: string; actor_id: string; document: string }>;
source.close();
const target = new SocietyStore(targetFile);
try {
  target.db.transaction(() => {
    // Identical immutable IDs are idempotent; a collision never overwrites data.
    const put = (table: "studies" | "study_trials" | "decision_cases", id: string, document: string, values: string[]) => {
      const existing = target.db.prepare(`select document from ${table} where id=?`).get(id) as { document: string } | undefined;
      if (existing) { if (existing.document !== document) throw new Error(`${table} ID 冲突：${id}`); return; }
      target.db.prepare(`insert into ${table} values (${values.map(() => "?").join(",")})`).run(...values);
    };
    put("studies", study.id, row.document, [study.id, row.document]);
    for (const r of results) put("study_trials", r.id, r.document, [r.id, r.study_id, r.document]);
    for (const c of cases) put("decision_cases", c.id, c.document, [c.id, c.run_id, c.actor_id, c.document]);
  })();
  console.log(JSON.stringify({ studyId: study.id, sourceFile, targetFile, trials: results.length, cases: cases.length, mode: "immutable-copy" }));
} finally { target.close(); }
