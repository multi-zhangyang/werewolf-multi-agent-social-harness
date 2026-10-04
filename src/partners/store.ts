import type Database from "better-sqlite3";
import type { AgentInputItem } from "@openai/agents";
import { createHash } from "node:crypto";
import type { ActorId, WorldState } from "./contracts";
import type { PartnerMind, EpisodicMemory } from "./mind";
import type { PartnerDecisionCase } from "./agent";
import type { CheckpointSummary, CreateRun, DecisionSummary, Mechanism, ResearchMetrics, RunStatus, StudySpec, ToolActivity } from "./api-types";
import type { StoredIntervention } from "./intervention-types";

export interface StoredPartnerRun {
  id: string; title: string; createdAt: string; version: number; status: RunStatus;
  spec: CreateRun; ownerHash: string; playerHashes: Partial<Record<ActorId, string>>;
  world: WorldState; minds: Record<ActorId, PartnerMind>;
  memories: Record<ActorId, EpisodicMemory[]>; sessions: Record<ActorId, AgentInputItem[]>;
  activities: ToolActivity[]; error?: string; activeActor?: ActorId;
  parentId?: string; checkpointId?: string; condition?: string; studyId?: string;
  interventionId?: string;
  experimentNote?: string; hidden?: boolean;
}
export interface Checkpoint extends CheckpointSummary {
  runId: string;
  state: Pick<StoredPartnerRun, "world" | "minds" | "memories" | "sessions" | "spec">;
}
export interface StoredStudy {
  id: string; createdAt: string; ownerHash: string; spec: StudySpec;
  status: "paused" | "running" | "completed" | "stopped";
  rows: { runId: string; condition: "none" | "apology" | "compensation"; agreeableness: number; mechanism: Mechanism; repeat: number }[];
}
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");

/** Incremental, namespaced tables. A turn and its exact research case commit together. */
export class PartnerStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS partner_runs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS partner_checkpoint_run ON partner_checkpoints(run_id,revision);
      CREATE TABLE IF NOT EXISTS partner_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS partner_case_run ON partner_cases(run_id);
      CREATE TABLE IF NOT EXISTS partner_studies (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_interventions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    `);
  }
  get(id: string): StoredPartnerRun | undefined { return this.read("partner_runs", id); }
  list(): StoredPartnerRun[] { return this.all("partner_runs"); }
  save(run: StoredPartnerRun): void { this.write("partner_runs", run.id, run); }
  transact<T>(operation: () => T): T { return this.db.transaction(operation)(); }
  checkpoint(run: StoredPartnerRun): Checkpoint {
    const checkpoint: Checkpoint = { id: `${run.id}:${run.world.revision}`, runId: run.id, revision: run.world.revision,
      round: run.world.round, phase: run.world.phase, createdAt: new Date().toISOString(),
      state: structuredClone({ world: run.world, minds: run.minds, memories: run.memories, sessions: run.sessions, spec: run.spec }) };
    this.db.prepare("INSERT OR IGNORE INTO partner_checkpoints(id,run_id,revision,document) VALUES (?,?,?,?)")
      .run(checkpoint.id, run.id, checkpoint.revision, JSON.stringify(checkpoint));
    return checkpoint;
  }
  getCheckpoint(id: string): Checkpoint | undefined { return this.read("partner_checkpoints", id); }
  checkpoints(runId: string): Checkpoint[] {
    return (this.db.prepare("SELECT document FROM partner_checkpoints WHERE run_id=? ORDER BY revision").all(runId) as {document:string}[]).map(row => JSON.parse(row.document));
  }
  inheritCheckpoints(sourceRunId: string, run: StoredPartnerRun, throughRevision: number): void {
    for (const checkpoint of this.checkpoints(sourceRunId)) if (checkpoint.revision <= throughRevision && checkpoint.revision < run.world.revision) {
      const state = structuredClone(checkpoint.state); state.world.id = run.id;
      this.checkpoint({ ...run, ...state });
    }
  }
  saveCase(runId: string, value: PartnerDecisionCase): void {
    this.db.prepare("INSERT INTO partner_cases(id,run_id,document) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(value.id, runId, JSON.stringify(value));
  }
  cases(runId: string): PartnerDecisionCase[] {
    return (this.db.prepare("SELECT document FROM partner_cases WHERE run_id=? ORDER BY rowid").all(runId) as {document:string}[]).map(row => JSON.parse(row.document));
  }
  decisionSummaries(runId: string): DecisionSummary[] {
    return (this.db.prepare(`SELECT json_remove(document, '$.exchanges', '$.activities', '$.observation', '$.transportNormalizations',
      '$.shadow.exchanges', '$.shadow.activities') AS document FROM partner_cases WHERE run_id=? ORDER BY rowid`)
      .all(runId) as { document: string }[]).map(row => JSON.parse(row.document));
  }
  metrics(runId: string): ResearchMetrics {
    return this.db.prepare(`SELECT COUNT(*) AS decisions,
      COALESCE(SUM(json_extract(document, '$.failures')),0) AS failures, COALESCE(SUM(json_extract(document, '$.retries')),0) AS retries,
      COALESCE(SUM(json_extract(document, '$.inputTokens')),0) AS inputTokens, COALESCE(SUM(json_extract(document, '$.outputTokens')),0) AS outputTokens,
      COALESCE(SUM(json_extract(document, '$.durationMs')),0) AS durationMs FROM partner_cases WHERE run_id=?`).get(runId) as ResearchMetrics;
  }
  getStudy(id: string): StoredStudy | undefined { return this.read("partner_studies", id); }
  studies(): StoredStudy[] { return this.all("partner_studies"); }
  saveStudy(study: StoredStudy): void { this.write("partner_studies", study.id, study); }
  getIntervention(id: string): StoredIntervention | undefined { return this.read("partner_interventions", id); }
  interventions(): StoredIntervention[] { return this.all("partner_interventions"); }
  saveIntervention(batch: StoredIntervention): void { this.write("partner_interventions", batch.id, batch); }
  recover(): void {
    this.transact(() => {
      for (const run of this.list()) if (run.status === "running") {
        run.status = "paused"; run.error = "服务重启，未提交的行动已取消；可从最近检查点继续。";
        delete run.activeActor; run.version++;
        for (const activity of run.activities) if (activity.status === "running") {
          activity.status = "failed"; activity.output = "服务重启，调用未提交"; activity.finishedAt = new Date().toISOString();
        }
        this.save(run);
      }
      for (const study of this.studies()) if (study.status === "running") { study.status = "paused"; this.saveStudy(study); }
      for (const batch of this.interventions()) if (batch.status === "running") { batch.status = "paused"; this.saveIntervention(batch); }
    });
  }
  private read<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT document FROM ${table} WHERE id=?`).get(id) as {document:string} | undefined;
    return row ? JSON.parse(row.document) as T : undefined;
  }
  private all<T>(table: string): T[] {
    return (this.db.prepare(`SELECT document FROM ${table} ORDER BY rowid DESC`).all() as {document:string}[]).map(row => JSON.parse(row.document) as T);
  }
  private write(table: string, id: string, document: unknown): void {
    this.db.prepare(`INSERT INTO ${table}(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(id, JSON.stringify(document));
  }
}
