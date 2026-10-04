import Database from "better-sqlite3";
import { memoryMatchScore, memoryQueryTerms } from "./memory-search";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RunError, type Character, type CharacterSnapshot, type EventDraft, type Memory, type RunSpec, type RunStatus, type WorldEvent } from "./types";
import type { DecisionCase } from "./cases";
import type { AgentMind } from "../agents/cognition";

export interface StoredRun {
  id: string; spec: RunSpec; characters: Character[]; status: RunStatus; createdAt: string;
  ownerHash: string; playerHashes: Record<string, string>;
  modelConfigs?: Record<string, Record<string, unknown>>;
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class SocietyStore {
  readonly db: Database.Database;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_world_writer ON runs(world_id) WHERE mode='continuity' AND status IN ('running','paused');
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, document TEXT NOT NULL, UNIQUE(run_id,seq));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), text TEXT NOT NULL, document TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, world_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS heads (world_id TEXT NOT NULL, character_id TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), PRIMARY KEY(world_id,character_id));
      CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cases_by_run ON decision_cases(run_id);
      CREATE TABLE IF NOT EXISTS studies (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS study_trials (id TEXT PRIMARY KEY, study_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sdk_sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_minds (run_id TEXT NOT NULL REFERENCES runs(id), actor_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(run_id,actor_id));
      CREATE TABLE IF NOT EXISTS agent_activations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), actor_id TEXT NOT NULL);
    `);
  }
  recoverInterrupted() { for (const run of this.list()) if (["running", "paused"].includes(run.status)) this.setStatus(run.id, "interrupted"); }
  close() { this.db.close(); }
  cognition(runId: string, actorId: string): AgentMind | undefined {
    const row = this.db.prepare("SELECT document FROM agent_minds WHERE run_id=? AND actor_id=?").get(runId, actorId) as { document: string } | undefined;
    return row && JSON.parse(row.document);
  }
  saveCognition(runId: string, mind: AgentMind) {
    this.db.prepare("INSERT INTO agent_minds VALUES (?,?,?) ON CONFLICT(run_id,actor_id) DO UPDATE SET document=excluded.document").run(runId, mind.actorId, JSON.stringify(mind));
  }
  activationCommitted(id: string) { return Boolean(this.db.prepare("SELECT 1 FROM agent_activations WHERE id=?").get(id)); }
  commitActivation(id: string, runId: string, actorId: string) { this.db.prepare("INSERT INTO agent_activations VALUES (?,?,?)").run(id, runId, actorId); }
  saveCase(record: DecisionCase) { this.db.prepare("INSERT INTO decision_cases VALUES (?,?,?,?)").run(record.id, record.runId, record.actorId, JSON.stringify(record)); }
  getCase(id: string): DecisionCase | undefined { const row = this.db.prepare("SELECT document FROM decision_cases WHERE id=?").get(id) as { document: string } | undefined; return row && JSON.parse(row.document); }
  cases(runId: string): DecisionCase[] { return (this.db.prepare("SELECT document FROM decision_cases WHERE run_id=? ORDER BY rowid").all(runId) as { document: string }[]).map(r => JSON.parse(r.document)); }
  saveStudy(record: { id: string }) { this.db.prepare("INSERT INTO studies VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(record.id, JSON.stringify(record)); }
  study<T>(id: string): T | undefined { const r = this.db.prepare("SELECT document FROM studies WHERE id=?").get(id) as { document: string } | undefined; return r && JSON.parse(r.document); }
  studies<T>(): T[] { return (this.db.prepare("SELECT document FROM studies ORDER BY rowid DESC").all() as { document: string }[]).map(r => JSON.parse(r.document)); }
  saveTrial(studyId: string, record: { id: string }) { this.db.prepare("INSERT INTO study_trials VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(record.id, studyId, JSON.stringify(record)); }
  trial<T>(studyId: string, id: string): T | undefined { const r = this.db.prepare("SELECT document FROM study_trials WHERE id=? AND study_id=?").get(id, studyId) as { document: string } | undefined; return r && JSON.parse(r.document); }
  create(run: StoredRun) {
    if (run.spec.mode === "continuity" && this.db.prepare("SELECT 1 FROM runs WHERE world_id=? AND mode='continuity' AND status IN ('running','paused')").get(run.spec.worldId)) {
      throw new RunError("这个连续世界已有正在进行的对局");
    }
    this.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(run.id, run.spec.worldId, run.spec.mode, run.status, JSON.stringify(run));
  }
  get(id: string): StoredRun | undefined {
    const row = this.db.prepare("SELECT document FROM runs WHERE id=?").get(id) as { document: string } | undefined;
    return row && JSON.parse(row.document);
  }
  list(): StoredRun[] { return (this.db.prepare("SELECT document FROM runs ORDER BY rowid DESC").all() as { document: string }[]).map(x => JSON.parse(x.document)); }
  setStatus(id: string, status: RunStatus) {
    const run = this.get(id)!;
    run.status = status;
    this.db.prepare("UPDATE runs SET status=?, document=? WHERE id=?").run(status, JSON.stringify(run), id);
  }
  events(runId: string, after = 0): WorldEvent[] {
    return (this.db.prepare("SELECT document FROM events WHERE run_id=? AND seq>? ORDER BY seq").all(runId, after) as { document: string }[]).map(x => JSON.parse(x.document));
  }
  event(id: string): WorldEvent | undefined {
    const row = this.db.prepare("SELECT document FROM events WHERE id=?").get(id) as { document: string } | undefined;
    return row && JSON.parse(row.document);
  }
  append(runId: string, draft: EventDraft, recipients: string[]): WorldEvent {
    return this.db.transaction(() => {
      const seq = (this.db.prepare("SELECT coalesce(max(seq),0)+1 AS n FROM events WHERE run_id=?").get(runId) as { n: number }).n;
      const event: WorldEvent = { ...draft, id: randomUUID(), runId, seq, at: new Date().toISOString() };
      this.db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(event.id, runId, seq, JSON.stringify(event));
      if (["message", "fact", "action"].includes(event.type)) for (const characterId of recipients) {
        this.addMemory({ id: randomUUID(), characterId, runId, kind: "experience", text: event.text, sourceIds: [event.id], about: event.actorId ? [event.actorId] : [], at: event.at });
      }
      return event;
    })();
  }
  addMemory(memory: Memory) {
    this.db.prepare("INSERT INTO memories VALUES (?,?,?,?,?)").run(memory.id, memory.characterId, memory.runId, memory.text, JSON.stringify(memory));
    this.db.prepare("INSERT INTO memory_search (id,text) VALUES (?,?)").run(memory.id, memory.text);
  }
  memories(ids: string[]): Memory[] {
    const lookup = this.db.prepare("SELECT document FROM memories WHERE id=?");
    return ids.flatMap(id => { const row = lookup.get(id) as { document: string } | undefined; return row ? [JSON.parse(row.document)] : []; });
  }
  currentMemories(runId: string, actorId: string): Memory[] {
    return (this.db.prepare("SELECT document FROM memories WHERE run_id=? AND character_id=? ORDER BY rowid").all(runId, actorId) as { document: string }[]).map(x => JSON.parse(x.document));
  }
  recall(actorId: string, allowed: Memory[], query: string, about?: string): Memory[] {
    const terms = memoryQueryTerms(query);
    const indexed = terms.filter(term => term.length >= 3);
    const expression = indexed.map(term => '"' + term.replaceAll('"', '""') + '"').join(" OR ");
    const hits = new Set<string>(expression ? (this.db.prepare("SELECT id FROM memory_search WHERE memory_search MATCH ?").all(expression) as { id: string }[]).map(x => x.id) : []);
    return allowed.filter(m => m.characterId === actorId && (!about || m.about.includes(about)))
      .map(m => ({ memory: m, score: memoryMatchScore(m.text, terms) || Number(hits.has(m.id)) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.memory.kind === "note") - Number(a.memory.kind === "note") || b.memory.at.localeCompare(a.memory.at))
      .slice(0, 12).map(m => m.memory);
  }
  snapshot(id: string): CharacterSnapshot | undefined {
    const row = this.db.prepare("SELECT document FROM snapshots WHERE id=?").get(id) as { document: string } | undefined;
    return row && JSON.parse(row.document);
  }
  snapshots(actorId: string): CharacterSnapshot[] {
    return (this.db.prepare("SELECT document FROM snapshots WHERE character_id=? ORDER BY rowid DESC").all(actorId) as { document: string }[]).map(x => JSON.parse(x.document));
  }
  head(worldId: string, actorId: string): string | undefined {
    return (this.db.prepare("SELECT snapshot_id FROM heads WHERE world_id=? AND character_id=?").get(worldId, actorId) as { snapshot_id: string } | undefined)?.snapshot_id;
  }
  complete(run: StoredRun) {
    this.db.transaction(() => {
      for (const character of run.characters) {
        const parentId = run.spec.initialSnapshots[character.id];
        const parent = parentId ? this.snapshot(parentId) : undefined;
        const snapshot: CharacterSnapshot = { id: randomUUID(), characterId: character.id, worldId: run.spec.worldId, runId: run.id, parentId, at: new Date().toISOString(), memoryIds: [...(parent?.memoryIds ?? []), ...this.currentMemories(run.id, character.id).map(m => m.id)], cognition: this.cognition(run.id, character.id) };
        this.db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?)").run(snapshot.id, character.id, run.spec.worldId, run.id, JSON.stringify(snapshot));
        if (run.spec.mode === "continuity") this.db.prepare("INSERT INTO heads VALUES (?,?,?) ON CONFLICT(world_id,character_id) DO UPDATE SET snapshot_id=excluded.snapshot_id").run(run.spec.worldId, character.id, snapshot.id);
      }
      this.setStatus(run.id, "completed");
    })();
  }
  annotate(runId: string, document: Record<string, unknown>) {
    const annotation = { ...document, id: randomUUID(), at: new Date().toISOString() };
    this.db.prepare("INSERT INTO annotations VALUES (?,?,?)").run(annotation.id, runId, JSON.stringify(annotation));
    return annotation;
  }
  annotations(runId: string): Record<string, unknown>[] { return (this.db.prepare("SELECT document FROM annotations WHERE run_id=? ORDER BY rowid").all(runId) as { document: string }[]).map(x => JSON.parse(x.document)); }
}
