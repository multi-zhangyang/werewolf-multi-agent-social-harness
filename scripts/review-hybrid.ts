import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { psychologyFromEvent } from "../src/runtime/psychology";
import type { StudyRecord, TrialResult } from "../src/runtime/studies";

// Export a fixed selection for content review; this script does not rate text or call models.
const manifest = JSON.parse(readFileSync("data/v5-final-studies.json", "utf8")) as Record<string, { id: string; database: string }>;
const stages = ["1:after-repair", "2:pledge", "2:return", "2:repair", "3:invest"];
for (const kind of ["repair", "free"]) {
  const entry = manifest[kind];
  const db = new Database(entry.database, { readonly: true });
  try {
    const study = JSON.parse((db.prepare("select document from studies where id=?").get(entry.id) as { document: string }).document) as StudyRecord;
    const trials = study.trials.filter(t => kind === "free" || t.repeat === 0 && t.mechanism === "hybrid");
    const samples = trials.map(trial => {
      const row = db.prepare("select document from study_trials where id=?").get(trial.id) as { document: string } | undefined;
      const result = row ? JSON.parse(row.document) as TrialResult : undefined;
      const events = result?.events ?? [];
      return {
        trialId: trial.id, runId: trial.runId, status: trial.status, agreeableness: trial.agreeableness, condition: trial.condition,
        error: trial.error, durationMs: trial.durationMs,
        actions: events.filter(e => e.type === "action").map(e => ({ eventId: e.id, actor: e.actorId, ...e.data })),
        messages: events.filter(e => e.type === "message").map(e => ({ eventId: e.id, actor: e.actorId, text: e.text, ...e.data })),
        moments: events.flatMap(e => {
          const state = psychologyFromEvent(e);
          return state && stages.includes(String(e.data.stageId)) ? [{ eventId: e.id, actor: e.actorId, stage: e.data.stageId, state }] : [];
        }),
        unobservedStages: stages.filter(stage => !events.some(e => e.data.stageId === stage && psychologyFromEvent(e))),
      };
    });
    const output = resolve(kind === "free" ? "data/v5-stability-audit" : "data/v5-verified-audit");
    mkdirSync(output, { recursive: true });
    const path = resolve(output, kind === "free" ? "manual-free-samples.json" : "manual-samples.json");
    writeFileSync(path, JSON.stringify({ studyId: study.id, sourceHash: study.sourceHash, status: study.status, stages,
      selection: kind === "free" ? "All six planned games, including failures and unobserved stages." : "All repeat-0 hybrid trials, including failures; selected before the batch ended.",
      reviewer: "Export only. Any accompanying code-assistant assessment is exploratory, not independent human review.", samples }, null, 2));
    console.log(JSON.stringify({ kind, samples: samples.length, path }));
  } finally { db.close(); }
}
