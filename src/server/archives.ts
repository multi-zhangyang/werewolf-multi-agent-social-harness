import { readdir, readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type express from 'express';
import type { ServerContext } from './context';
import { isOperatorFor, tokenFromRequest } from './auth';
import type { StorageHealth } from './storage';

export interface ArchiveMeta { id: string; scenarioId: string; title: string; createdAt: string; finishedAt: string; }
export interface LegacyArchive extends ArchiveMeta {
  schemaVersion: 1;
  ownerTokenHash: string;
  room: Record<string, unknown>;
  publicRoom: Record<string, unknown>;
  envelopes: unknown[];
}
export function archiveDir() { return process.env.SOCIETY_ARCHIVE_DIR?.trim() || 'data/archives'; }
export function isArchiveOwner(archive: LegacyArchive, token: string | undefined) {
  if (!token) return false;
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(archive.ownerTokenHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function readRoomArchive(id: string, storage?: StorageHealth): Promise<LegacyArchive | undefined> {
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(id)) return;
  try {
    const data = JSON.parse(await readFile(path.join(archiveDir(), `${id}.json`), 'utf8')) as LegacyArchive;
    return data.id === id && data.schemaVersion === 1 ? data : undefined;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') storage?.record({ store: 'archives', code: 'READ_FAILED' }); }
}
export async function listRoomArchives(storage?: StorageHealth): Promise<ArchiveMeta[]> {
  let entries: string[];
  try { entries = await readdir(archiveDir()); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') storage?.record({ store: 'archives', code: 'READ_FAILED' }); return []; }
  const result: ArchiveMeta[] = [];
  for (const file of entries.filter(f => f.endsWith('.json'))) {
    const archive = await readRoomArchive(file.slice(0, -5), storage);
    if (archive) result.push({ id: archive.id, scenarioId: archive.scenarioId, title: archive.title, createdAt: archive.createdAt, finishedAt: archive.finishedAt });
  }
  return result.sort((a,b) => b.finishedAt.localeCompare(a.finishedAt));
}
export function registerArchiveRoutes(app: express.Express, context: ServerContext) {
  app.get('/api/archives', async (_request, response) => response.json({ archives: await listRoomArchives(context.storage) }));
  app.get('/api/archives/:id', async (request, response) => {
    const archive = await readRoomArchive(request.params.id, context.storage);
    if (!archive) { response.status(404).json({ message: '归档不存在' }); return; }
    const privileged = isOperatorFor(context.auth, request) || isArchiveOwner(archive, tokenFromRequest(request));
    response.json({ room: privileged ? archive.room : archive.publicRoom, envelopes: privileged ? archive.envelopes : [] });
  });
}
