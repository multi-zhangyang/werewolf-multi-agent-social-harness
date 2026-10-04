import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("data/v5-final-studies.json", "utf8"));
while (true) {
  const snapshot = { at: new Date().toISOString(), studies: [] };
  for (const [kind, entry] of Object.entries(manifest)) {
    const db = new Database(entry.database, { readonly: true });
    const record = JSON.parse(db.prepare("select document from studies where id=?").get(entry.id).document);
    snapshot.studies.push({ id: record.id, kind, status: record.status, completed: record.trials.filter(t => t.status === "completed").length, failed: record.trials.filter(t => t.status === "failed").map(t => ({ id: t.id, error: t.error })), running: record.trials.filter(t => t.status === "running").length, planned: record.trials.length });
    db.close();
  }
  writeFileSync("data/v5-monitor.json", JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify(snapshot));
  if (snapshot.studies.every(s => s.status !== "running")) break;
  await new Promise(resolve => setTimeout(resolve, 45000));
}
