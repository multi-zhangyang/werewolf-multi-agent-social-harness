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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
  }

  load(roomId: string): RoomCheckpoint | undefined {
    const file = this.checkpointFile(roomId);
    if (!existsSync(file)) return undefined;
    return this.readCheckpoint(file, roomId);
  }

  /** Summaries of all archived rooms, newest first (for the landing room list). */
  list(): ArchivedRoomSummary[] {
    if (!existsSync(this.dir)) return [];
    return this.readAll()
      .filter((checkpoint): checkpoint is RoomCheckpoint => Boolean(checkpoint))
      .map((checkpoint) => ({
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
        }))
      }))
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
  }

  /**
   * Checkpoints whose rooms were interrupted (status running/paused, not
   * disposed, with enough state to rebuild). These are candidates for
   * restart recovery at boot.
   */
  interrupted(): RoomCheckpoint[] {
    if (!existsSync(this.dir)) return [];
    return this.readAll()
      .filter((checkpoint): checkpoint is RoomCheckpoint => Boolean(checkpoint))
      .filter((checkpoint) => checkpoint.status === "running" || checkpoint.status === "paused")
      .filter((checkpoint) => checkpoint.recoverable !== false)
      .filter((checkpoint) => Array.isArray(checkpoint.profiles) && checkpoint.profiles.length >= 2)
      .filter((checkpoint) => Boolean(checkpoint.worldState))
      .filter((checkpoint) => checkpoint.snapshot.mode !== "human")
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
  }

  diagnostics(): RoomArchiveFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  private readAll(): Array<RoomCheckpoint | undefined> {
    let names: string[];
    try {
      names = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (cause) {
      this.recordError("ARCHIVE_LIST_FAILED", "list", undefined, true, cause);
      return [];
    }
    return names.map((name) => {
      const file = path.join(this.dir, name, "checkpoint.json");
      if (!existsSync(file)) return undefined;
      try {
        return this.readCheckpoint(file, name);
      } catch {
        return undefined;
      }
    });
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
