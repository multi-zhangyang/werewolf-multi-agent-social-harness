import Database from "better-sqlite3";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tables = [
  { name: "runs", columns: ["id", "world_id", "mode", "status", "document"], keys: ["id"] },
  { name: "events", columns: ["id", "run_id", "seq", "document"], keys: ["id"] },
  { name: "memories", columns: ["id", "character_id", "run_id", "text", "document"], keys: ["id"] },
  { name: "snapshots", columns: ["id", "character_id", "world_id", "run_id", "document"], keys: ["id"] },
  { name: "decision_cases", columns: ["id", "run_id", "actor_id", "document"], keys: ["id"] },
  { name: "agent_minds", columns: ["run_id", "actor_id", "document"], keys: ["run_id", "actor_id"] },
  { name: "agent_activations", columns: ["id", "run_id", "actor_id"], keys: ["id"] },
  { name: "annotations", columns: ["id", "run_id", "document"], keys: ["id"] },
  { name: "studies", columns: ["id", "document"], keys: ["id"] },
  { name: "study_trials", columns: ["id", "study_id", "document"], keys: ["id"] },
] as const;
type Row = Record<string, string | number | null>;

/** Append completed/failed evidence only. Existing rows, continuity heads and SDK sessions are never rewritten. */
export function importGeneralResults(sourceFile: string, targetFile: string) {
  const sourcePath = realpathSync(path.resolve(sourceFile)), targetPath = realpathSync(path.resolve(targetFile));
  const sourceStat = statSync(sourcePath, { bigint: true }), targetStat = statSync(targetPath, { bigint: true });
  if (sourcePath.toLowerCase() === targetPath.toLowerCase() || sourceStat.ino !== 0n && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev)
    throw new Error("Source and target must be different SQLite files");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = new Database(targetPath, { fileMustExist: true });
  try {
    target.pragma("foreign_keys = ON");
    return source.transaction(() => {
      for (const table of ["runs", "studies"] as const) for (const row of source.prepare(`SELECT document FROM ${table}`).iterate() as Iterable<{ document: string }>)
        if (["running", "paused"].includes(JSON.parse(row.document).status)) throw new Error(`Source ${table} contains unfinished work`);
      return target.transaction(() => {
        const result = [];
        for (const table of tables) {
          const sourceColumns = source.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>;
          if (!sourceColumns.length) continue;
          const targetColumns = target.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>;
          if (table.columns.some(name => !sourceColumns.some(c => c.name === name) || !targetColumns.some(c => c.name === name)))
            throw new Error(`Incompatible ${table.name} schema; start the current server to initialize its schema`);
          const columns = table.columns.join(",");
          const get = target.prepare(`SELECT ${columns} FROM ${table.name} WHERE ${table.keys.map(key => `${key}=?`).join(" AND ")}`);
          const insert = target.prepare(`INSERT INTO ${table.name} (${columns}) VALUES (${table.columns.map(() => "?").join(",")})`);
          let inserted = 0, identical = 0;
          for (const row of source.prepare(`SELECT ${columns} FROM ${table.name} ORDER BY rowid`).iterate() as Iterable<Row>) {
            if (typeof row.document === "string") {
              const document = JSON.parse(row.document);
              if (!document || typeof document !== "object" || "id" in row && document.id !== row.id) throw new Error(`Invalid ${table.name} document identity`);
            }
            const old = get.get(...table.keys.map(key => row[key])) as Row | undefined;
            if (old) {
              if (table.columns.some(column => old[column] !== row[column])) throw new Error(`Conflicting existing ${table.name} row; whole import rolled back`);
              identical++; continue;
            }
            insert.run(...table.columns.map(column => row[column])); inserted++;
          }
          result.push({ table: table.name, inserted, identical });
        }
        return { tables: result, inserted: result.reduce((sum, item) => sum + item.inserted, 0), headsUnchanged: true };
      }).immediate();
    })();
  } finally { target.close(); source.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [source, target, ...extra] = process.argv.slice(2);
  if (!source || !target || extra.length) throw new Error("Usage: node --import tsx scripts/import-general-results.ts <source.sqlite> <existing-target.sqlite>");
  console.log(JSON.stringify(importGeneralResults(source, target)));
}
