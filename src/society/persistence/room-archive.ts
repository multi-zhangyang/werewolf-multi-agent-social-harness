/**
 * Room checkpoint archive.
 *
 * Every room writes a rolling checkpoint under `data/rooms/<roomId>/`:
 * the latest observer-safe snapshot, the retained event envelopes, and a
 * manifest pointing at each agent's durable session file. Checkpoints let an
 * interrupted room be rehydrated for inspection and are the foundation for
 * resume-from-checkpoint (restart recovery is a later milestone). No provider
 * secrets ever reach the archive: it only holds what the SSE stream already
 * exposes to an observer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentMindState, AgentProfile, ScenarioId } from "../contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "../room";
import type { WorldSerializedState } from "../world";

export interface RoomCheckpoint {
  roomId: string;
  archivedAt: string;
  status: string;
  snapshot: SocietyRoomSnapshot;
  envelopes: SocietyRoomEventEnvelope[];
  /** Protected, low-frequency replay anchors retained beyond SSE deltas. */
  replayEnvelopes?: SocietyRoomEventEnvelope[];
  agentMinds: Record<string, AgentMindState>;
  sessionFiles: Record<string, string>;
  /** Full participant profiles (character + controller), for recovery. */
  profiles?: AgentProfile[];
  /** Serialized world rules state, for recovery. */
  worldState?: WorldSerializedState;
  /** Per-agent model bindings at checkpoint time, for recovery. */
  agentBindings?: Record<string, { defaultModelProfileId?: string; tuningOverrides?: Record<string, unknown> }>;
  pausedAgents?: string[];
  seasonMode?: "season" | "one-shot";
  /** Smoke-gate counters (AGENTS.md §37), written at checkpoint time. */
  runtimeStats?: { extractionFailures: number; settledAbandonedTurns: number };
  /** The room's control token, persisted so recovery keeps the same owner. */
  ownerToken?: string;
  /** False when the room was disposed on purpose — not restarted on boot. */
  recoverable?: boolean;
}

export interface ArchivedRoomSummary {
  roomId: string;
  archivedAt: string;
  status: string;
  title: string;
  scenarioId: ScenarioId;
  messages: number;
  logEntries: number;
  participants: Array<{ id: string; displayName: string; model: string }>;
  /** Recovery pre-filters, so boot never parses a checkpoint just to skip it. */
  mode?: string;
  recoverable?: boolean;
  profileCount?: number;
}

export function defaultRoomArchiveDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "data", "rooms");
}

export class RoomArchiveStore {
  private readonly failures: RoomArchiveFailure[] = [];

  constructor(private readonly dir = defaultRoomArchiveDir()) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw this.recordError("ARCHIVE_INITIALIZE_FAILED", "initialize", undefined, false, cause);
    }
  }

  checkpointFile(roomId: string): string {
    const safeId = roomId.replace(/[^A-Za-z0-9_.:-]/g, "_");
    return path.join(this.dir, safeId, "checkpoint.json");
  }

  summaryFile(roomId: string): string {
    const safeId = roomId.replace(/[^A-Za-z0-9_.:-]/g, "_");
    return path.join(this.dir, safeId, "summary.json");
  }

  save(checkpoint: RoomCheckpoint): void {
    const file = this.checkpointFile(checkpoint.roomId);
    const temporary = `${file}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
      renameSync(temporary, file);
    } catch (cause) {
      throw this.recordError("ARCHIVE_WRITE_FAILED", "save", checkpoint.roomId, true, cause);
    }
    // Keep a tiny summary beside every checkpoint so the landing room list
    // never parses the full (envelope-heavy) checkpoint. A summary write
    // failure must not fail the authoritative save; list() rebuilds lazily.
    try {
      writeFileSync(this.summaryFile(checkpoint.roomId), JSON.stringify(this.summarize(checkpoint)), { mode: 0o600 });
    } catch (cause) {
      console.warn(`[room-archive] summary write failed for ${checkpoint.roomId}:`, cause instanceof Error ? cause.message : cause);
    }
  }

  load(roomId: string): RoomCheckpoint | undefined {
    const file = this.checkpointFile(roomId);
    if (!existsSync(file)) return undefined;
    return this.readCheckpoint(file, roomId);
  }

/** Summaries of all archived rooms, newest first (for the landing room list). */
  list(): ArchivedRoomSummary[] {
    if (!existsSync(this.dir)) return [];
    const summaries: ArchivedRoomSummary[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const summaryFile = path.join(this.dir, entry.name, "summary.json");
      const checkpointFile = path.join(this.dir, entry.name, "checkpoint.json");
      try {
        // Fast path: the per-room summary written at save time. Reading the
        // full checkpoint here would parse every replay envelope on every
        // landing-page poll and stall the event loop (and SSE frames).
        if (existsSync(summaryFile)) {
          const parsed = JSON.parse(readFileSync(summaryFile, "utf8")) as ArchivedRoomSummary;
          if (typeof parsed.roomId === "string") {
            summaries.push(parsed);
            continue;
          }
        }
        // Legacy rooms without a summary: parse once and rebuild the file.
        if (!existsSync(checkpointFile)) continue;
        const checkpoint = this.readCheckpoint(checkpointFile, entry.name);
        const summary = this.summarize(checkpoint);
        try {
          writeFileSync(summaryFile, JSON.stringify(summary), { mode: 0o600 });
        } catch { /* rebuilt lazily on the next call */ }
        summaries.push(summary);
      } catch {
        // readCheckpoint already recorded the corruption as an operator-
        // visible failure; one bad room must not sink the whole list.
      }
    }
    return summaries.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
  }

  private summarize(checkpoint: RoomCheckpoint): ArchivedRoomSummary {
    return {
      roomId: checkpoint.roomId,
      archivedAt: checkpoint.archivedAt,
      status: checkpoint.status,
      title: checkpoint.snapshot.title,
      scenarioId: checkpoint.snapshot.scenarioId,
      messages: checkpoint.snapshot.world.messages.length,
      logEntries: checkpoint.snapshot.world.log.length,
      participants: checkpoint.snapshot.participants.map((participant) => ({
        id: participant.profile.id,
        displayName: participant.profile.displayName,
        model: participant.profile.model
      })),
      mode: checkpoint.snapshot.mode,
      recoverable: checkpoint.recoverable,
      profileCount: checkpoint.snapshot.participants.length
    };
  }

  /**
   * Checkpoints whose rooms were interrupted (status running/paused, not
   * disposed, with enough state to rebuild). These are candidates for
   * restart recovery at boot.
   *
   * Boot must never parse every archived checkpoint: summaries answer
   * "is this a candidate?" for free, so only genuinely interrupted rooms
   * are read in full. A room without the recovery summary fields (legacy
   * archive) stays a candidate and is decided by its checkpoint.
   */
  interrupted(): RoomCheckpoint[] {
    if (!existsSync(this.dir)) return [];
    const checkpoints: RoomCheckpoint[] = [];
    for (const candidate of this.recoveryCandidates()) {
      try {
        checkpoints.push(this.readCheckpoint(candidate.file, candidate.roomId));
      } catch {
        // readCheckpoint already recorded the failure; skip this room.
      }
    }
    return checkpoints
      .filter((checkpoint) => checkpoint.status === "running" || checkpoint.status === "paused")
      .filter((checkpoint) => checkpoint.recoverable !== false)
      .filter((checkpoint) => Array.isArray(checkpoint.profiles) && checkpoint.profiles.length >= 2)
      .filter((checkpoint) => Boolean(checkpoint.worldState))
      .filter((checkpoint) => checkpoint.snapshot.mode !== "human")
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
  }

  /** Directories that may hold a recoverable checkpoint, cheapest read first. */
  private recoveryCandidates(): Array<{ file: string; roomId: string }> {
    let entries;
    try {
      entries = readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (cause) {
      this.recordError("ARCHIVE_LIST_FAILED", "list", undefined, true, cause);
      return [];
    }
    const candidates: Array<{ file: string; roomId: string }> = [];
    for (const entry of entries) {
      const file = path.join(this.dir, entry.name, "checkpoint.json");
      if (!existsSync(file)) continue;
      let summary: Partial<ArchivedRoomSummary> | undefined;
      try {
        const parsed = JSON.parse(readFileSync(path.join(this.dir, entry.name, "summary.json"), "utf8")) as Partial<ArchivedRoomSummary>;
        if (typeof parsed.roomId === "string") summary = parsed;
      } catch {
        summary = undefined;
      }
      if (summary) {
        if (summary.status !== "running" && summary.status !== "paused") continue;
        if (summary.recoverable === false) continue;
        if (summary.mode === "human") continue;
        if (typeof summary.profileCount === "number" && summary.profileCount < 2) continue;
      }
      candidates.push({ file, roomId: entry.name });
    }
    return candidates;
  }

  diagnostics(): RoomArchiveFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  /**
   * Retention (§31): terminal archived rooms would otherwise accumulate
   * forever (multi-GB archives made boot a full-disk scan). The reap keeps
   * the newest `maxRooms` terminal rooms and deletes the rest, oldest
   * first. Rooms that could still be recovered (status running/paused with
   * recoverable !== false, or a legacy summary that cannot prove
   * terminality) are never deleted. Every removal is logged and returned.
   */
  reap(options?: { maxRooms?: number }): Array<{ roomId: string; reason: "retention-cap" }> {
    const maxRooms = options?.maxRooms ?? positiveIntegerFromEnv("SOCIETY_ARCHIVE_MAX_ROOMS", 24);
    if (!existsSync(this.dir)) return [];
    let entries;
    try {
      entries = readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return [];
    }
    const terminal: Array<{ roomId: string; dir: string; archivedAt: string }> = [];
    for (const entry of entries) {
      const dir = path.join(this.dir, entry.name);
      const summary = this.readSummaryEntry(dir);
      if (!summary) continue;
      const recoverable = summary.recoverable !== false
        && (summary.status === "running" || summary.status === "paused" || summary.status === "lobby");
      const explicitlyDisposed = summary.recoverable === false;
      if (recoverable || (!explicitlyDisposed && summary.status !== "finished" && summary.status !== "error")) continue;
      terminal.push({ roomId: summary.roomId, dir, archivedAt: summary.archivedAt });
    }
    terminal.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
    const removed: Array<{ roomId: string; reason: "retention-cap" }> = [];
    for (const room of terminal.slice(maxRooms)) {
      try {
        removeDirectorySync(room.dir);
        if (existsSync(room.dir)) throw new Error("directory still present after removal");
        removed.push({ roomId: room.roomId, reason: "retention-cap" });
        console.warn(`[room-archive] reaped terminal room ${room.roomId} (archive capped at ${maxRooms})`);
      } catch (cause) {
        console.warn(`[room-archive] reap failed for ${room.roomId}:`, cause instanceof Error ? cause.message : cause);
      }
    }
    return removed;
  }

  /** Best-effort summary read; missing/corrupt summaries are not reapable. */
  private readSummaryEntry(dir: string): ArchivedRoomSummary | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) as Partial<ArchivedRoomSummary>;
      if (typeof parsed.roomId !== "string" || typeof parsed.archivedAt !== "string" || typeof parsed.status !== "string") return undefined;
      return parsed as ArchivedRoomSummary;
    } catch {
      return undefined;
    }
  }

  private readCheckpoint(file: string, expectedRoomId?: string): RoomCheckpoint {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (cause) {
      throw this.recordError("ARCHIVE_READ_FAILED", "load", expectedRoomId, true, cause);
    }
    try {
      const parsed = JSON.parse(text) as Partial<RoomCheckpoint>;
      if (typeof parsed.roomId !== "string" || !parsed.snapshot || (expectedRoomId && parsed.roomId !== expectedRoomId)) {
        throw new Error("invalid checkpoint envelope");
      }
      return parsed as RoomCheckpoint;
    } catch (cause) {
      throw this.recordError("ARCHIVE_CORRUPT", "load", expectedRoomId, false, cause);
    }
  }

  private recordError(
    code: RoomArchiveFailure["code"],
    operation: RoomArchiveOperation,
    roomId: string | undefined,
    retryable: boolean,
    cause: unknown
  ): RoomArchiveError {
    const failure: RoomArchiveFailure = {
      code,
      operation,
      ...(roomId ? { roomId } : {}),
      retryable,
      at: new Date().toISOString()
    };
    this.failures.push(failure);
    if (this.failures.length > 50) this.failures.splice(0, this.failures.length - 50);
    // Failures must be operator-visible: a corrupt checkpoint otherwise makes a
    // room silently disappear from the list and from restart recovery.
    console.warn(`[room-archive] ${failure.code} during ${failure.operation}${roomId ? ` (room ${roomId})` : ""}:`, cause instanceof Error ? cause.message : cause);
    return new RoomArchiveError(failure, { cause });
  }
}

export type RoomArchiveOperation = "initialize" | "save" | "load" | "list";

export interface RoomArchiveFailure {
  code: "ARCHIVE_INITIALIZE_FAILED" | "ARCHIVE_WRITE_FAILED" | "ARCHIVE_READ_FAILED" | "ARCHIVE_CORRUPT" | "ARCHIVE_LIST_FAILED";
  operation: RoomArchiveOperation;
  roomId?: string;
  retryable: boolean;
  at: string;
}

export class RoomArchiveError extends Error {
  constructor(readonly failure: RoomArchiveFailure, options?: ErrorOptions) {
    super(failure.code, options);
    this.name = "RoomArchiveError";
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Windows-safe recursive directory removal. On some filter-driver setups
 * (antivirus/indexer) Node's `rmSync(recursive)` silently leaves freshly
 * written entries behind, so removal is stepwise: unlink children, then the
 * directory, falling back to rmSync for states stepwise deletion cannot
 * express. A removal that did not actually remove throws.
 */
function removeDirectorySync(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) removeDirectorySync(child);
      else unlinkSync(child);
    }
    rmdirSync(dir);
  } catch {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (existsSync(dir)) {
    // One short retry round: a filter driver can hold a handle for a moment.
    try {
      removeDirectorySync(dir);
    } catch {
      throw new Error(`could not remove ${dir}`);
    }
  }
}
