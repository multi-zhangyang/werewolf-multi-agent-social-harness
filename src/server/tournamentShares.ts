import path from "node:path";
import express from "express";
import { redactSecrets } from "../harness/redaction";
import {
  TOURNAMENT_PUBLIC_SHARE_INDEX_FILE,
  flattenTournamentArtifactFiles,
  isFileReadNotFound,
  normalizeRequestedArtifactPath
} from "./artifactFiles";
import { tournamentProjectionFromUnknown } from "./artifactSetStore";
import type { ServerAppDependencies } from "./context";
import { HttpError } from "./httpValidation";
import { isRecord, nonNegativeIntegerField, optionalIsoTimestampField, stringArrayField, stringField } from "./jsonUtil";
import {
  DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  type StoredTournamentArtifactSet,
  type StoredTournamentPublicShare,
  type TournamentPublicShareEventRetentionPolicy,
  getTournamentPublicShare,
  listTournamentPublicShares,
  pruneAllTournamentPublicShareEvents,
  retainDownloadEvents,
  retainTimestampEvents,
  saveTournamentPublicShare
} from "./store";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export let activePublicShareEventRetention: TournamentPublicShareEventRetentionPolicy = {
  ...DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION
};

export function serializeTournamentPublicShare(share: StoredTournamentPublicShare): object {
  return {
    shareId: share.id,
    id: share.id,
    artifactSetId: share.artifactSetId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    label: share.label ?? null,
    relativeFiles: share.relativeFiles ?? null,
    projection: share.projection ?? null,
    expired: isTournamentPublicShareExpired(share),
    analytics: {
      detailViewCount: Math.max(0, share.detailViewCount ?? 0),
      downloadCount: Math.max(0, share.downloadCount ?? 0),
      downloadsByFile: normalizeDownloadsByFile(share.downloadsByFile),
      downloadEvents: normalizeDownloadEvents(share.downloadEvents),
      detailViewEvents: normalizeTimestampEvents(share.detailViewEvents),
      downloadsByMinute: bucketEventsByMinute(normalizeDownloadEvents(share.downloadEvents).map((event) => event.at)),
      detailViewsByMinute: bucketEventsByMinute(normalizeTimestampEvents(share.detailViewEvents)),
      lastDetailViewedAt: share.lastDetailViewedAt ?? null,
      lastDownloadedAt: share.lastDownloadedAt ?? null,
      lastDownloadedFile: share.lastDownloadedFile ?? null
    },
    urls: {
      detail: `/api/public/tournament-shares/${encodeURIComponent(share.id)}`,
      filesBase: `/api/public/tournament-shares/${encodeURIComponent(share.id)}/files`
    }
  };
}

export function serializeTournamentPublicShareDetail(
  share: StoredTournamentPublicShare,
  artifactSet: StoredTournamentArtifactSet
): object {
  const shareableFiles = shareableTournamentArtifactFiles(share, artifactSet);
  return {
    ...serializeTournamentPublicShare(share),
    packCreatedAt: artifactSet.createdAt,
    files: shareableFiles,
    downloads: mapTournamentArtifactFileList(shareableFiles, (relativePath) =>
      tournamentPublicShareDownloadUrl(share.id, relativePath)
    )
  };
}

export function tournamentPublicShareDownloadUrl(shareId: string, relativePath: string): string {
  return `/api/public/tournament-shares/${encodeURIComponent(shareId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function shareableTournamentArtifactFiles(
  share: StoredTournamentPublicShare,
  artifactSet: StoredTournamentArtifactSet
): string[] {
  const registered = flattenTournamentArtifactFiles(artifactSet.relativeFiles);
  if (!share.relativeFiles) return registered;
  const allow = new Set(share.relativeFiles);
  return registered.filter((file) => allow.has(file));
}

export function mapTournamentArtifactFileList(
  files: string[],
  mapFile: (relativePath: string) => string
): string[] {
  return files.map(mapFile);
}

export function resolvePublicShareDownloadRateLimit(
  override: ServerAppDependencies["publicShareDownloadRateLimit"] | undefined,
  env: NodeJS.ProcessEnv
): { maxDownloads: number; windowMs: number; now: () => number } {
  const maxDownloads =
    override?.maxDownloads ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_LIMIT, 60);
  const windowMs =
    override?.windowMs ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_WINDOW_MS, 60_000);
  return {
    maxDownloads,
    windowMs,
    now: override?.now ?? (() => Date.now())
  };
}

export function resolvePublicShareEventRetention(
  override: TournamentPublicShareEventRetentionPolicy | undefined,
  env: NodeJS.ProcessEnv
): TournamentPublicShareEventRetentionPolicy {
  const maxEvents =
    override?.maxEvents ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_EVENT_MAX, DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxEvents);
  let maxAgeMs: number | null | undefined = override?.maxAgeMs;
  if (maxAgeMs === undefined) {
    const raw = env.TOURNAMENT_PUBLIC_SHARE_EVENT_MAX_AGE_MS;
    if (raw === undefined || raw === null || raw === "") {
      maxAgeMs = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxAgeMs ?? null;
    } else if (raw === "0" || raw.toLowerCase() === "none" || raw.toLowerCase() === "off") {
      maxAgeMs = null;
    } else {
      maxAgeMs = parseEnvPositiveInteger(raw, DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
    }
  }
  return {
    maxEvents,
    maxAgeMs: maxAgeMs ?? null
  };
}

export function parseEnvPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function requestClientKey(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0]?.trim() || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function consumePublicShareDownloadRateLimit(
  buckets: Map<string, number[]>,
  key: string,
  config: { maxDownloads: number; windowMs: number; now: () => number }
): { allowed: boolean; retryAfterSeconds: number } {
  const now = config.now();
  const windowStart = now - config.windowMs;
  const recent = (buckets.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
  if (recent.length >= config.maxDownloads) {
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1, oldest + config.windowMs - now);
    buckets.set(key, recent);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }
  recent.push(now);
  buckets.set(key, recent);
  // Bound memory for long-running processes: drop empty/stale keys opportunistically.
  if (buckets.size > 10_000) {
    for (const [bucketKey, timestamps] of buckets) {
      const kept = timestamps.filter((timestamp) => timestamp > windowStart);
      if (!kept.length) buckets.delete(bucketKey);
      else buckets.set(bucketKey, kept);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function requireActiveTournamentPublicShare(shareId: string): StoredTournamentPublicShare {
  const share = getTournamentPublicShare(shareId);
  if (!share) throw new HttpError(404, "tournament public share not found");
  if (isTournamentPublicShareExpired(share)) throw new HttpError(410, "tournament public share expired");
  return share;
}

export function isTournamentPublicShareExpired(share: StoredTournamentPublicShare, now = Date.now()): boolean {
  if (!share.expiresAt) return false;
  const expiresAtMs = Date.parse(share.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
}

export interface TournamentPublicShareAnalyticsSummaryShare {
  shareId: string;
  artifactSetId: string;
  label: string | null;
  expired: boolean;
  packFound: boolean;
  packCreatedAt: string | null;
  detailViewCount: number;
  downloadCount: number;
  topFiles: Array<{ file: string; count: number }>;
  lastDetailViewedAt: string | null;
  lastDownloadedAt: string | null;
  lastDownloadedFile: string | null;
}

export interface TournamentPublicShareAnalyticsSummary {
  artifactVersion: "harness.tournament-public-share-analytics.v1";
  kind: "tournament-public-share-analytics";
  createdAt: string;
  totals: {
    shareCount: number;
    activeShareCount: number;
    expiredShareCount: number;
    packMissingCount: number;
    detailViewCount: number;
    downloadCount: number;
  };
  topFiles: Array<{ file: string; count: number }>;
  downloadsByMinute: Array<{ minute: string; count: number }>;
  detailViewsByMinute: Array<{ minute: string; count: number }>;
  shares: TournamentPublicShareAnalyticsSummaryShare[];
}

export function renderTournamentPublicShareAnalyticsSummaryMarkdown(summary: TournamentPublicShareAnalyticsSummary): string {
  const lines = [
    "# Tournament Public Share Analytics",
    "",
    `- artifactVersion: \`${summary.artifactVersion}\``,
    `- createdAt: \`${summary.createdAt}\``,
    "",
    "## Totals",
    "",
    `| metric | value |`,
    `| --- | ---: |`,
    `| shares | ${summary.totals.shareCount} |`,
    `| active | ${summary.totals.activeShareCount} |`,
    `| expired | ${summary.totals.expiredShareCount} |`,
    `| pack missing | ${summary.totals.packMissingCount} |`,
    `| detail views | ${summary.totals.detailViewCount} |`,
    `| downloads | ${summary.totals.downloadCount} |`,
    "",
    "## Top Files",
    ""
  ];
  if (!summary.topFiles.length) {
    lines.push("_No downloads recorded._", "");
  } else {
    lines.push("| file | downloads |", "| --- | ---: |");
    for (const entry of summary.topFiles) {
      lines.push(`| \`${entry.file}\` | ${entry.count} |`);
    }
    lines.push("");
  }
  lines.push("## Shares", "");
  if (!summary.shares.length) {
    lines.push("_No public shares registered._", "");
  } else {
    lines.push(
      "| share | label | pack | views | downloads | last file | status |",
      "| --- | --- | --- | ---: | ---: | --- | --- |"
    );
    for (const share of summary.shares) {
      const status = share.expired ? "expired" : share.packFound ? "active" : "pack-missing";
      lines.push(
        `| \`${share.shareId.slice(0, 12)}\` | ${share.label ?? "-"} | \`${share.artifactSetId.slice(0, 12)}\` | ${share.detailViewCount} | ${share.downloadCount} | \`${share.lastDownloadedFile ?? "-"}\` | ${status} |`
      );
    }
    lines.push("");
  }
  lines.push("## Recent Download Minutes", "");
  if (!summary.downloadsByMinute.length) {
    lines.push("_No download minute buckets._", "");
  } else {
    lines.push("| minute | downloads |", "| --- | ---: |");
    for (const bucket of summary.downloadsByMinute.slice(-20)) {
      lines.push(`| \`${bucket.minute}\` | ${bucket.count} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function parseOptionalShareExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "expiresAt must be an ISO-8601 string or null.");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new HttpError(400, "expiresAt must be a valid ISO-8601 timestamp.");
  if (ms <= Date.now()) throw new HttpError(400, "expiresAt must be in the future.");
  return new Date(ms).toISOString();
}

export function parseOptionalShareRelativeFiles(
  value: unknown,
  artifactSet: StoredTournamentArtifactSet
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const files = stringArrayField({ relativeFiles: value }, "relativeFiles");
  if (!files) throw new HttpError(400, "relativeFiles must be a non-empty string array when provided.");
  const registered = new Set(flattenTournamentArtifactFiles(artifactSet.relativeFiles));
  const unique = [...new Set(files.map((file) => normalizeRequestedArtifactPath(file)))];
  for (const file of unique) {
    if (!registered.has(file)) {
      throw new HttpError(400, "relativeFiles must only include registered tournament artifact files.");
    }
  }
  return unique;
}

export async function loadTournamentPublicShareIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(tournamentPublicShareIndexPath(root), "utf8")) as unknown;
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw new HttpError(500, "Tournament public share index could not be read.");
  }
  if (!isRecord(parsed) || parsed.kind !== "tournament-public-share-index" || !Array.isArray(parsed.shares)) {
    return;
  }
  for (const record of parsed.shares) {
    const share = tournamentPublicShareFromUnknown(record);
    if (!share) continue;
    if (!getTournamentPublicShare(share.id)) {
      saveTournamentPublicShare(share);
    }
  }
  pruneAllTournamentPublicShareEvents(activePublicShareEventRetention);
}

export async function writeTournamentPublicShareIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const shares = listTournamentPublicShares().map((share) => ({
    id: share.id,
    artifactSetId: share.artifactSetId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    label: share.label ?? null,
    relativeFiles: share.relativeFiles ?? null,
    projection: share.projection ?? null,
    detailViewCount: Math.max(0, share.detailViewCount ?? 0),
    downloadCount: Math.max(0, share.downloadCount ?? 0),
    downloadsByFile: normalizeDownloadsByFile(share.downloadsByFile),
    downloadEvents: normalizeDownloadEvents(share.downloadEvents),
    detailViewEvents: normalizeTimestampEvents(share.detailViewEvents),
    lastDetailViewedAt: share.lastDetailViewedAt ?? null,
    lastDownloadedAt: share.lastDownloadedAt ?? null,
    lastDownloadedFile: share.lastDownloadedFile ?? null
  }));
  const index = {
    artifactVersion: "harness.tournament-public-share-index.v1",
    kind: "tournament-public-share-index",
    updatedAt: new Date().toISOString(),
    shares
  };
  await writeFile(tournamentPublicShareIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

export function tournamentPublicShareIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), TOURNAMENT_PUBLIC_SHARE_INDEX_FILE);
}

export function tournamentPublicShareFromUnknown(value: unknown): StoredTournamentPublicShare | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const artifactSetId = stringField(value, "artifactSetId");
  const createdAt = stringField(value, "createdAt");
  if (!id || !artifactSetId || !createdAt) return null;
  if (!/^[0-9a-f]{48}$/i.test(id)) return null;
  const expiresAtRaw = value.expiresAt;
  let expiresAt: string | null = null;
  if (expiresAtRaw !== null && expiresAtRaw !== undefined) {
    if (typeof expiresAtRaw !== "string" || !Number.isFinite(Date.parse(expiresAtRaw))) return null;
    expiresAt = expiresAtRaw;
  }
  const label = typeof value.label === "string" && value.label.length > 0 ? value.label : undefined;
  let relativeFiles: string[] | undefined;
  if (value.relativeFiles !== null && value.relativeFiles !== undefined) {
    const parsed = stringArrayField(value, "relativeFiles");
    if (!parsed) return null;
    relativeFiles = parsed;
  }
  const detailViewCount = nonNegativeIntegerField(value, "detailViewCount") ?? 0;
  const downloadCount = nonNegativeIntegerField(value, "downloadCount") ?? 0;
  const downloadsByFile = normalizeDownloadsByFile(value.downloadsByFile);
  const downloadEvents = normalizeDownloadEvents(value.downloadEvents);
  const detailViewEvents = normalizeTimestampEvents(value.detailViewEvents);
  const lastDetailViewedAt = optionalIsoTimestampField(value, "lastDetailViewedAt");
  const lastDownloadedAt = optionalIsoTimestampField(value, "lastDownloadedAt");
  const lastDownloadedFile =
    typeof value.lastDownloadedFile === "string" && value.lastDownloadedFile.length > 0
      ? value.lastDownloadedFile
      : null;
  return {
    id,
    artifactSetId,
    createdAt,
    expiresAt,
    label,
    relativeFiles,
    projection: tournamentProjectionFromUnknown(value.projection),
    detailViewCount,
    downloadCount,
    downloadsByFile,
    downloadEvents,
    detailViewEvents,
    lastDetailViewedAt,
    lastDownloadedAt,
    lastDownloadedFile
  };
}

export function normalizeDownloadsByFile(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || typeof key !== "string") continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) continue;
    out[key] = raw;
  }
  return out;
}

export function normalizeDownloadEvents(value: unknown): Array<{ at: string; file: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ at: string; file: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const at = typeof item.at === "string" && Number.isFinite(Date.parse(item.at)) ? item.at : null;
    const file = typeof item.file === "string" && item.file.length > 0 ? item.file : null;
    if (!at || !file) continue;
    out.push({ at, file });
  }
  return retainDownloadEvents(out, activePublicShareEventRetention);
}

export function normalizeTimestampEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !Number.isFinite(Date.parse(item))) continue;
    out.push(item);
  }
  return retainTimestampEvents(out, activePublicShareEventRetention);
}

export function bucketEventsByMinute(timestamps: string[]): Array<{ minute: string; count: number }> {
  const counts = new Map<string, number>();
  for (const timestamp of timestamps) {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) continue;
    const minute = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([minute, count]) => ({ minute, count }));
}

export function setActivePublicShareEventRetention(policy: TournamentPublicShareEventRetentionPolicy): void {
  activePublicShareEventRetention = policy;
}
