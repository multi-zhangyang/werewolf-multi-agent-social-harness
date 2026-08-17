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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentMindState, ScenarioId } from "../contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "../room";

export interface RoomCheckpoint {
  roomId: string;
  archivedAt: string;
  status: string;
  snapshot: SocietyRoomSnapshot;
  envelopes: SocietyRoomEventEnvelope[];
  agentMinds: Record<string, AgentMindState>;
  sessionFiles: Record<string, string>;
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
  constructor(private readonly dir = defaultRoomArchiveDir()) {
    mkdirSync(dir, { recursive: true });
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
    } catch {
      // Best-effort checkpoint; the room keeps running without it.
    }
  }

  load(roomId: string): RoomCheckpoint | undefined {
    const file = this.checkpointFile(roomId);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoomCheckpoint>;
      if (typeof parsed.roomId !== "string" || !parsed.snapshot) return undefined;
      return parsed as RoomCheckpoint;
    } catch {
      return undefined;
    }
  }

  /** Summaries of all archived rooms, newest first (for the landing room list). */
  list(): ArchivedRoomSummary[] {
    if (!existsSync(this.dir)) return [];
    return readdirSafe(this.dir)
      .map((name) => readFileSafe(path.join(this.dir, name, "checkpoint.json")))
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
}

import { readdirSync } from "node:fs";
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readFileSafe(file: string): RoomCheckpoint | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoomCheckpoint>;
    if (typeof parsed.roomId !== "string" || !parsed.snapshot) return undefined;
    return parsed as RoomCheckpoint;
  } catch {
    return undefined;
  }
}