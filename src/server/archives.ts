/**
 * Opt-in archive persistence for finished games.
 *
 * The runtime core stays zero-disk: a room is archived only when its creator
 * explicitly asked for it at creation time, and the write happens exactly
 * once, when the game finishes. Archive files are user data (like model
 * settings and the character library): they live under `data/archives/`,
 * which is gitignored, and they contain the omniscient end state — including
 * private minds — so opening one requires the room owner's token (matched
 * against a stored sha256, never the raw secret) or the operator token.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { archiveOwnerTokenHash, type SocietyRoomArchive } from "../society/room";
import { atomicWriteJson, quarantineCorruptFile, type StorageHealth } from "./storage";

/** Metadata exposed by the archive list; no snapshot payload crosses this boundary. */
export interface ArchiveMeta {
  id: string;
  scenarioId: string;
  title: string;
  createdAt: string;
  finishedAt: string;
}

/** Room ids are `room_<uuid>`; anything else would be a path-traversal attempt. */
function safeArchiveId(id: string): string | undefined {
  return /^[A-Za-z0-9_-]{4,120}$/.test(id) ? id : undefined;
}

export function archiveDir(): string {
  return process.env.SOCIETY_ARCHIVE_DIR?.trim() || "data/archives";
}

export function isArchiveOwner(archive: SocietyRoomArchive, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(archive.ownerTokenHash);
  const given = Buffer.from(archiveOwnerTokenHash(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function writeRoomArchive(archive: SocietyRoomArchive, storage?: StorageHealth): Promise<void> {
  const id = safeArchiveId(archive.id);
  if (!id) throw new Error(`ARCHIVE_ID_INVALID: '${archive.id}' is not a storable archive id.`);
  const directory = archiveDir();
  await mkdir(directory, { recursive: true });
  try {
    atomicWriteJson(join(directory, `${id}.json`), archive);
  } catch (error) {
    storage?.record({ store: "archives", code: "WRITE_FAILED" });
    throw error;
  }
}

export async function listRoomArchives(storage?: StorageHealth): Promise<ArchiveMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(archiveDir());
  } catch (error) {
    if (!isMissing(error)) storage?.record({ store: "archives", code: "READ_FAILED" });
    return [];
  }
  const metas: ArchiveMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const archive = JSON.parse(await readFile(join(archiveDir(), entry), "utf8")) as SocietyRoomArchive;
      if (archive?.id && archive.schemaVersion === 1) {
        metas.push({
          id: archive.id,
          scenarioId: archive.scenarioId,
          title: archive.title,
          createdAt: archive.createdAt,
          finishedAt: archive.finishedAt
        });
      }
    } catch {
      const quarantined = quarantineCorruptFile(join(archiveDir(), entry));
      storage?.record({ store: "archives", code: quarantined ? "CORRUPT_FILE_QUARANTINED" : "READ_FAILED" });
    }
  }
  return metas.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
}

export async function readRoomArchive(id: string, storage?: StorageHealth): Promise<SocietyRoomArchive | undefined> {
  const safe = safeArchiveId(id);
  if (!safe) return undefined;
  try {
    const archive = JSON.parse(await readFile(join(archiveDir(), `${safe}.json`), "utf8")) as SocietyRoomArchive;
    return archive?.id === safe && archive.schemaVersion === 1 ? archive : undefined;
  } catch (error) {
    if (!isMissing(error)) {
      const quarantined = quarantineCorruptFile(join(archiveDir(), `${safe}.json`));
      storage?.record({ store: "archives", code: quarantined ? "CORRUPT_FILE_QUARANTINED" : "READ_FAILED" });
    }
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function deleteRoomArchive(id: string): Promise<boolean> {
  const safe = safeArchiveId(id);
  if (!safe) return false;
  try {
    await rm(join(archiveDir(), `${safe}.json`));
    return true;
  } catch {
    return false;
  }
}
