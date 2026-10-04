import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SocietyStore } from "../../src/runtime/store";
import { importGeneralResults } from "../../scripts/import-general-results";

it("appends isolated evidence, leaves continuity heads alone and rolls back all inserts on a late conflict", () => {
  const directory = path.resolve(`data/import-general-test-${crypto.randomUUID()}`); mkdirSync(directory, { recursive: true });
  const sourceFile = path.join(directory, "source.sqlite"), targetFile = path.join(directory, "target.sqlite");
  new SocietyStore(sourceFile).close(); new SocietyStore(targetFile).close();
  const source = new Database(sourceFile), target = new Database(targetFile);
  try {
    const row = { id: "source-run", status: "completed" };
    source.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(row.id, "test-world", "experiment", row.status, JSON.stringify(row));
    source.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?)").run("snapshot", "self", "test-world", row.id, JSON.stringify({ id: "snapshot" }));
    source.prepare("INSERT INTO heads VALUES (?,?,?)").run("test-world", "self", "snapshot");
    expect(importGeneralResults(sourceFile, targetFile).inserted).toBe(2);
    expect(target.prepare("SELECT * FROM heads").all()).toEqual([]);
    expect(importGeneralResults(sourceFile, targetFile).inserted).toBe(0);
    source.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run("second", "test-world", "experiment", "completed", JSON.stringify({ id: "second", status: "completed" }));
    source.prepare("UPDATE snapshots SET document=? WHERE id='snapshot'").run(JSON.stringify({ id: "snapshot", changed: true }));
    expect(() => importGeneralResults(sourceFile, targetFile)).toThrow("whole import rolled back");
    expect(target.prepare("SELECT * FROM runs WHERE id='second'").get()).toBeUndefined();
    expect(target.prepare("SELECT document FROM snapshots WHERE id='snapshot'").get()).toEqual({ document: JSON.stringify({ id: "snapshot" }) });
  } finally { source.close(); target.close(); }
});
