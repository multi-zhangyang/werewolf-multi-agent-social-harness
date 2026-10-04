import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importPartnerResults } from "../../scripts/import-partners-results";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("partners-import-test-")) throw new Error("Refusing to remove an unexpected test directory");
    rmSync(resolved, { recursive: true, force: true });
  }
});

function files() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "partners-import-test-"));
  directories.push(directory);
  return { source: path.join(directory, "source.sqlite"), target: path.join(directory, "target.sqlite") };
}

function database(file: string, partnerTables = true) {
  const db = new Database(file);
  db.exec("CREATE TABLE legacy_archive(id TEXT PRIMARY KEY, document TEXT NOT NULL)");
  db.prepare("INSERT INTO legacy_archive VALUES (?, ?)").run("legacy", "preserve this old archive");
  if (partnerTables) db.exec(`
    CREATE TABLE partner_runs(id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE partner_checkpoints(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL);
    CREATE TABLE partner_cases(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL);
    CREATE TABLE partner_studies(id TEXT PRIMARY KEY, document TEXT NOT NULL);
  `);
  return db;
}

function seed(db: Database.Database, options: { status?: string; hidden?: boolean; activity?: string; studyStatus?: string } = {}) {
  db.prepare("INSERT INTO partner_runs VALUES (?, ?)").run("parent", JSON.stringify({ id: "parent", status: "failed", hidden: options.hidden ?? false,
    ownerHash: "credential-canary-do-not-print", error: "真实失败保留", activities: [] }));
  db.prepare("INSERT INTO partner_runs VALUES (?, ?)").run("child", JSON.stringify({ id: "child", status: options.status ?? "completed", parentId: "parent",
    activities: options.activity ? [{ id: "tool", status: options.activity }] : [] }));
  db.prepare("INSERT INTO partner_checkpoints VALUES (?, ?, ?, ?)").run("child:1", "child", 1, JSON.stringify({ id: "child:1", runId: "child", revision: 1, state: { originalEvidence: "exact source content" } }));
  db.prepare("INSERT INTO partner_cases VALUES (?, ?, ?)").run("case", "parent", JSON.stringify({ id: "case", status: "failed", response: "truncation", retries: 1 }));
  db.prepare("INSERT INTO partner_studies VALUES (?, ?)").run("study", JSON.stringify({ id: "study", status: options.studyStatus ?? "completed", rows: [{ runId: "child" }] }));
}

const fingerprint = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("read-only partner result import", () => {
  it("imports only partner rows, preserves IDs, ancestry and failures, and leaves source bytes unchanged", () => {
    const paths = files(); const source = database(paths.source); seed(source); source.close();
    const target = database(paths.target, false);
    target.prepare("UPDATE legacy_archive SET document=?").run("target archive must survive"); target.close();
    const before = fingerprint(paths.source);
    const result = importPartnerResults(paths.source, paths.target);
    expect(result).toMatchObject({ inserted: 5, skippedIdentical: 0 });
    expect(result.tables.map(table => table.sourceRows)).toEqual([2, 1, 1, 1]);
    expect(fingerprint(paths.source)).toBe(before);
    const imported = new Database(paths.target, { readonly: true });
    try {
      expect((imported.prepare("SELECT document FROM legacy_archive").get() as { document: string }).document).toBe("target archive must survive");
      expect(JSON.parse((imported.prepare("SELECT document FROM partner_runs WHERE id='child'").get() as { document: string }).document)).toMatchObject({ id: "child", parentId: "parent", status: "completed" });
      expect(JSON.parse((imported.prepare("SELECT document FROM partner_cases").get() as { document: string }).document)).toMatchObject({ status: "failed", retries: 1 });
    } finally { imported.close(); }
    expect(JSON.stringify(result)).not.toContain("credential-canary-do-not-print");
  });

  it("skips identical duplicates, including JSON object key-order differences", () => {
    const paths = files(); const source = database(paths.source); seed(source); source.close();
    const target = database(paths.target); target.close();
    importPartnerResults(paths.source, paths.target);
    const reorder = new Database(paths.target);
    const row = reorder.prepare("SELECT document FROM partner_runs WHERE id='parent'").get() as { document: string };
    reorder.prepare("UPDATE partner_runs SET document=? WHERE id='parent'").run(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(row.document)).reverse()))); reorder.close();
    expect(importPartnerResults(paths.source, paths.target)).toMatchObject({ inserted: 0, skippedIdentical: 5 });
  });

  it("rolls back earlier inserts when a later duplicate document differs, without exposing document secrets", () => {
    const paths = files(); const source = database(paths.source); seed(source); source.close();
    const target = database(paths.target);
    target.prepare("INSERT INTO partner_cases VALUES (?, ?, ?)").run("case", "parent", JSON.stringify({ id: "case", status: "failed", response: "different-private-response" })); target.close();
    let message = "";
    try { importPartnerResults(paths.source, paths.target); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Import conflict");
    expect(message).not.toContain("different-private-response");
    expect(message).not.toContain("credential-canary-do-not-print");
    const check = new Database(paths.target, { readonly: true });
    try {
      expect(check.prepare("SELECT count(*) AS n FROM partner_runs").get()).toEqual({ n: 0 });
      expect(check.prepare("SELECT count(*) AS n FROM partner_checkpoints").get()).toEqual({ n: 0 });
      expect(check.prepare("SELECT count(*) AS n FROM partner_cases").get()).toEqual({ n: 1 });
    } finally { check.close(); }
  });

  it("treats a hidden flag or association-column change as a real conflict", () => {
    const paths = files(); const source = database(paths.source); seed(source); source.close();
    const target = database(paths.target); seed(target, { hidden: true }); target.close();
    expect(() => importPartnerResults(paths.source, paths.target)).toThrow("Import conflict");
    const fix = new Database(paths.target);
    const parent = JSON.parse((fix.prepare("SELECT document FROM partner_runs WHERE id='parent'").get() as { document: string }).document);
    parent.hidden = false;
    fix.prepare("UPDATE partner_runs SET document=? WHERE id='parent'").run(JSON.stringify(parent));
    fix.prepare("UPDATE partner_checkpoints SET revision=2 WHERE id='child:1'").run(); fix.close();
    expect(() => importPartnerResults(paths.source, paths.target)).toThrow("Import conflict");
  });

  it.each([
    { status: "running" }, { studyStatus: "running" }, { status: "paused", activity: "running" },
  ])("rejects an unfinished source before changing target tables: %j", options => {
    const paths = files(); const source = database(paths.source); seed(source, options); source.close();
    const target = database(paths.target, false); target.close();
    expect(() => importPartnerResults(paths.source, paths.target)).toThrow(/running|unfinished tool/);
    const check = new Database(paths.target, { readonly: true });
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'partner_%'").all()).toEqual([]); }
    finally { check.close(); }
  });

  it("rejects identical files and missing targets rather than creating a new database accidentally", () => {
    const paths = files(); const source = database(paths.source); seed(source); source.close();
    expect(() => importPartnerResults(paths.source, paths.source)).toThrow("different database");
    expect(() => importPartnerResults(paths.source, paths.target)).toThrow();
  });
});
