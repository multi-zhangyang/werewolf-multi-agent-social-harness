import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tables = [
  { name: "partner_runs", columns: ["id", "document"] },
  { name: "partner_checkpoints", columns: ["id", "run_id", "revision", "document"] },
  { name: "partner_cases", columns: ["id", "run_id", "document"] },
  { name: "partner_studies", columns: ["id", "document"] },
  { name: "partner_interventions", columns: ["id", "document"] },
] as const;
type Table = typeof tables[number];
type ImportRow = { id: string; document: string; run_id?: string; revision?: number };
export interface ImportCounts { table: Table["name"]; sourceRows: number; inserted: number; skippedIdentical: number }
export interface ImportResult { tables: ImportCounts[]; inserted: number; skippedIdentical: number }

const schema = `
  CREATE TABLE IF NOT EXISTS partner_runs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS partner_checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS partner_checkpoint_run ON partner_checkpoints(run_id,revision);
  CREATE TABLE IF NOT EXISTS partner_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS partner_case_run ON partner_cases(run_id);
  CREATE TABLE IF NOT EXISTS partner_studies (id TEXT PRIMARY KEY, document TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS partner_interventions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
`;

/** Identifiers in errors are hashed so no document text or credential can reach CLI output. */
function rowLabel(table: string, id: string): string {
  return `${table}, ID fingerprint ${createHash("sha256").update(String(id)).digest("hex").slice(0, 12)}`;
}
function documentOf(row: ImportRow, table: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(row.document); }
  catch { throw new Error(`Invalid JSON document (${rowLabel(table, row.id)}).`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON object (${rowLabel(table, row.id)}).`);
  const result = parsed as Record<string, unknown>;
  if (result.id !== row.id) throw new Error(`Document ID differs from its row ID (${rowLabel(table, row.id)}).`);
  return result;
}

/** Object key order is not a content change. Array order and all actual values remain significant. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function checkTable(database: Database.Database, table: Table, source: boolean): void {
  const columns = database.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string; pk: number }[];
  if (!columns.length || table.columns.some(name => !columns.some(column => column.name === name)) || !columns.some(column => column.name === "id" && column.pk === 1)) {
    throw new Error(`${source ? "Source" : "Target"} has an incompatible ${table.name} table.`);
  }
}

function assertStopped(row: ImportRow, table: string): void {
  const document = documentOf(row, table);
  if (document.status === "running") throw new Error(`Source contains a running record (${rowLabel(table, row.id)}); stop it before import.`);
  if (table === "partner_runs" && Array.isArray(document.activities)
      && document.activities.some(activity => activity && typeof activity === "object" && (activity as Record<string, unknown>).status === "running")) {
    throw new Error(`Source contains an unfinished tool activity (${rowLabel(table, row.id)}); wait for cancellation to settle before import.`);
  }
}

/**
 * Import a consistent, read-only snapshot. Both files must already exist and be distinct.
 * A conflict anywhere rolls back every insert (including newly created partner tables).
 * No historical non-partner table, source row, ID, or document is rewritten.
 */
export function importPartnerResults(sourceFile: string, targetFile: string): ImportResult {
  const sourcePath = realpathSync(path.resolve(sourceFile));
  const targetPath = realpathSync(path.resolve(targetFile));
  const sourceStat = statSync(sourcePath, { bigint: true }), targetStat = statSync(targetPath, { bigint: true });
  if (!sourceStat.isFile() || !targetStat.isFile()) throw new Error("Source and target must be existing SQLite files.");
  const samePath = process.platform === "win32" ? sourcePath.toLowerCase() === targetPath.toLowerCase() : sourcePath === targetPath;
  if (samePath || sourceStat.ino !== 0n && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev) throw new Error("Source and target must be different database files.");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  let target: Database.Database | undefined;
  try {
    // Older exports predate intervention batches; the four original tables remain required.
    const sourceTables = tables.filter(table => table.name !== "partner_interventions" || source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name));
    for (const table of sourceTables) checkTable(source, table, true);
    target = new Database(targetPath, { fileMustExist: true, timeout: 5000 });
    const destination = target;
    return source.transaction(() => {
      // This read fixes the source snapshot before any target writes. A live source is never imported.
      for (const table of sourceTables) {
        for (const row of source.prepare(`SELECT id, document FROM ${table.name}`).iterate() as Iterable<ImportRow>) assertStopped(row, table.name);
      }
      return destination.transaction(() => {
        destination.exec(schema);
        const counts: ImportCounts[] = [];
        for (const table of sourceTables) {
          checkTable(destination, table, false);
          const count: ImportCounts = { table: table.name, sourceRows: 0, inserted: 0, skippedIdentical: 0 };
          const columns = table.columns.join(", ");
          const get = destination.prepare(`SELECT ${columns} FROM ${table.name} WHERE id = ?`);
          const insert = destination.prepare(`INSERT OR IGNORE INTO ${table.name} (${columns}) VALUES (${table.columns.map(() => "?").join(", ")})`);
          for (const row of source.prepare(`SELECT ${columns} FROM ${table.name} ORDER BY rowid`).iterate() as Iterable<ImportRow>) {
            count.sourceRows++;
            const sourceDocument = documentOf(row, table.name);
            const previous = get.get(row.id) as ImportRow | undefined;
            if (previous) {
              const associatedColumnsEqual = table.columns.filter(column => column !== "document").every(column => row[column] === previous[column]);
              if (!associatedColumnsEqual || canonical(sourceDocument) !== canonical(documentOf(previous, table.name))) {
                throw new Error(`Import conflict: existing ID has different content (${rowLabel(table.name, row.id)}). Entire import rolled back.`);
              }
              count.skippedIdentical++;
              continue;
            }
            if (row.run_id && !destination.prepare("SELECT 1 FROM partner_runs WHERE id = ?").get(row.run_id)) {
              throw new Error(`Missing parent run for imported record (${rowLabel(table.name, row.id)}).`);
            }
            const result = insert.run(...table.columns.map(column => row[column]));
            if (result.changes !== 1) throw new Error(`A new record was not inserted (${rowLabel(table.name, row.id)}). Entire import rolled back.`);
            count.inserted++;
          }
          counts.push(count);
        }
        return { tables: counts, inserted: counts.reduce((total, item) => total + item.inserted, 0),
          skippedIdentical: counts.reduce((total, item) => total + item.skippedIdentical, 0) };
      }).immediate();
    })();
  } finally {
    target?.close();
    source.close();
  }
}

function main(args: string[]): void {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("Usage: node --import tsx scripts/import-partners-results.ts --source <source.sqlite> --target <existing-target.sqlite>\nOnly partner tables are imported; conflicting IDs abort the whole transaction.\n");
    return;
  }
  if (args.length !== 4 || !args.includes("--source") || !args.includes("--target")) throw new Error("Expected --source <source.sqlite> --target <existing-target.sqlite>. Use --help for usage.");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--source", "--target"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || options.has(args[i])) throw new Error("Invalid or repeated command-line option.");
    options.set(args[i], args[i + 1]);
  }
  const result = importPartnerResults(options.get("--source")!, options.get("--target")!);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // Never serialize Error objects, SQL parameters, or raw documents.
    process.stderr.write(`Import failed: ${error instanceof Error ? error.message : "unknown import error"}\n`);
    process.exitCode = 1;
  }
}
