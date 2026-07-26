import express from "express";
import { assertLocalResearchArtifactAccess } from "../artifactAccess";
import { contentTypeForArtifactFile, isFileReadNotFound, resolveRegisteredTournamentArtifactFile } from "../artifactFiles";
import {
  assertVerifiedPublicTournamentArtifactSet,
  getTournamentArtifactSetForBaseDir,
  loadTournamentArtifactSetIndex
} from "../artifactSetStore";
import type { ServerContext } from "../context";
import {
  FORBIDDEN_TOURNAMENT_SHARE_BODY_FIELDS,
  HttpError,
  assertForbiddenBodyFields,
  parseOptionalString,
  requestBodyObject
} from "../httpValidation";
import {
  type StoredTournamentPublicShare,
  createTournamentPublicShare,
  deleteTournamentPublicShare,
  getTournamentPublicShare,
  listTournamentPublicShares,
  recordTournamentPublicShareDetailView,
  recordTournamentPublicShareDownload,
  saveTournamentPublicShare
} from "../store";
import {
  type TournamentPublicShareAnalyticsSummary,
  activePublicShareEventRetention,
  bucketEventsByMinute,
  consumePublicShareDownloadRateLimit,
  isTournamentPublicShareExpired,
  loadTournamentPublicShareIndex,
  normalizeDownloadEvents,
  normalizeDownloadsByFile,
  normalizeTimestampEvents,
  parseOptionalShareExpiresAt,
  parseOptionalShareRelativeFiles,
  renderTournamentPublicShareAnalyticsSummaryMarkdown,
  requestClientKey,
  requireActiveTournamentPublicShare,
  serializeTournamentPublicShare,
  serializeTournamentPublicShareDetail,
  writeTournamentPublicShareIndex
} from "../tournamentShares";
import { readFile } from "node:fs/promises";

export function registerTournamentShareRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, tournamentArtifactBaseDir, publicShareDownloadRateLimit, publicShareDownloadBuckets, publicTournamentArtifactSetForShare } = context;

app.post("/api/tournament-artifacts/:id/shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_TOURNAMENT_SHARE_BODY_FIELDS, "tournament share create");
    const label = parseOptionalString(body.label, "label");
    const expiresAt = parseOptionalShareExpiresAt(body.expiresAt);
    const relativeFiles = parseOptionalShareRelativeFiles(body.relativeFiles, artifactSet);
    const share = createTournamentPublicShare({
      artifactSetId: artifactSet.id,
      label,
      expiresAt,
      relativeFiles,
      projection: artifactSet.projection
    });
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    saveTournamentPublicShare(share);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.status(201).json(serializeTournamentPublicShare(share));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-artifacts/:id/shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    res.json({
      artifactSetId: artifactSet.id,
      shares: listTournamentPublicShares(artifactSet.id).map(serializeTournamentPublicShare)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-public-shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const shares = listTournamentPublicShares().map(serializeTournamentPublicShareInventory);
    res.json({
      count: shares.length,
      activeCount: shares.filter((share) => !share.expired).length,
      expiredCount: shares.filter((share) => share.expired).length,
      shares
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-public-shares/summary", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const format = typeof req.query.format === "string" ? req.query.format.trim().toLowerCase() : "json";
    if (format !== "json" && format !== "markdown" && format !== "md") {
      res.status(400).json({ error: 'format must be "json" or "markdown"' });
      return;
    }
    const summary = buildTournamentPublicShareAnalyticsSummary();
    if (format === "markdown" || format === "md") {
      const markdown = renderTournamentPublicShareAnalyticsSummaryMarkdown(summary);
      res.setHeader("content-disposition", 'attachment; filename="tournament-public-share-analytics.md"');
      res.type("text/markdown; charset=utf-8").send(markdown);
      return;
    }
    res.setHeader("content-disposition", 'attachment; filename="tournament-public-share-analytics.json"');
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/tournament-shares/:shareId", async (req, res, next) => {
  try {
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = requireActiveTournamentPublicShare(req.params.shareId);
    const artifactSet = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "shared tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const viewed = recordTournamentPublicShareDetailView(share.id, new Date().toISOString(), activePublicShareEventRetention) ?? share;
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.json(serializeTournamentPublicShareDetail(viewed, artifactSet));
  } catch (error) {
    next(error);
  }
});

app.get(/^\/api\/public\/tournament-shares\/([^/]+)\/files\/(.+)$/, async (req, res, next) => {
  try {
    const params = req.params as unknown as string[];
    const shareId = params[0];
    const requestedPath = params[1];
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = requireActiveTournamentPublicShare(shareId);
    const artifactSet = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "shared tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const rateKey = `${share.id}:${requestClientKey(req)}`;
    const rate = consumePublicShareDownloadRateLimit(publicShareDownloadBuckets, rateKey, publicShareDownloadRateLimit);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      res.status(429).json({
        error: "public share download rate limit exceeded",
        retryAfterSeconds: rate.retryAfterSeconds,
        limit: publicShareDownloadRateLimit.maxDownloads,
        windowMs: publicShareDownloadRateLimit.windowMs
      });
      return;
    }
    const file = await resolveRegisteredTournamentArtifactFile(artifactSet, requestedPath, tournamentArtifactBaseDir);
    if (share.relativeFiles && !share.relativeFiles.includes(file.relativePath)) {
      res.status(404).json({ error: "shared tournament artifact file not found" });
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(file.absolutePath);
    } catch (error) {
      if (isFileReadNotFound(error)) {
        res.status(404).json({ error: "shared tournament artifact file not found" });
        return;
      }
      throw new HttpError(500, "shared tournament artifact file could not be read");
    }
    recordTournamentPublicShareDownload(share.id, file.relativePath, new Date().toISOString(), activePublicShareEventRetention);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.type(contentTypeForArtifactFile(file.relativePath)).send(content);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/public/tournament-shares/:shareId", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = getTournamentPublicShare(req.params.shareId);
    if (!share) {
      res.status(404).json({ error: "tournament public share not found" });
      return;
    }
    deleteTournamentPublicShare(share.id);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

function serializeTournamentPublicShareInventory(share: StoredTournamentPublicShare): {
  expired: boolean;
  [key: string]: unknown;
} {
  const artifactSet = publicTournamentArtifactSetForShare(share);
  return {
    ...serializeTournamentPublicShare(share),
    expired: isTournamentPublicShareExpired(share),
    packFound: Boolean(artifactSet),
    packCreatedAt: artifactSet?.createdAt ?? null
  };
}

function buildTournamentPublicShareAnalyticsSummary(now = Date.now()): TournamentPublicShareAnalyticsSummary {
  const shares = listTournamentPublicShares().map((share) => {
    const artifactSet = publicTournamentArtifactSetForShare(share);
    const downloadsByFile = normalizeDownloadsByFile(share.downloadsByFile);
    const topFiles = Object.entries(downloadsByFile)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));
    return {
      shareId: share.id,
      artifactSetId: share.artifactSetId,
      label: share.label ?? null,
      expired: isTournamentPublicShareExpired(share, now),
      packFound: Boolean(artifactSet),
      packCreatedAt: artifactSet?.createdAt ?? null,
      detailViewCount: Math.max(0, share.detailViewCount ?? 0),
      downloadCount: Math.max(0, share.downloadCount ?? 0),
      topFiles,
      lastDetailViewedAt: share.lastDetailViewedAt ?? null,
      lastDownloadedAt: share.lastDownloadedAt ?? null,
      lastDownloadedFile: share.lastDownloadedFile ?? null,
      downloadEvents: normalizeDownloadEvents(share.downloadEvents),
      detailViewEvents: normalizeTimestampEvents(share.detailViewEvents)
    };
  });

  const allDownloadEvents = shares.flatMap((share) => share.downloadEvents);
  const allDetailViewEvents = shares.flatMap((share) => share.detailViewEvents);
  const topFiles = new Map<string, number>();
  for (const share of shares) {
    for (const entry of share.topFiles) {
      topFiles.set(entry.file, (topFiles.get(entry.file) ?? 0) + entry.count);
    }
  }

  return {
    artifactVersion: "harness.tournament-public-share-analytics.v1",
    kind: "tournament-public-share-analytics",
    createdAt: new Date(now).toISOString(),
    totals: {
      shareCount: shares.length,
      activeShareCount: shares.filter((share) => !share.expired).length,
      expiredShareCount: shares.filter((share) => share.expired).length,
      packMissingCount: shares.filter((share) => !share.packFound).length,
      detailViewCount: shares.reduce((sum, share) => sum + share.detailViewCount, 0),
      downloadCount: shares.reduce((sum, share) => sum + share.downloadCount, 0)
    },
    topFiles: [...topFiles.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([file, count]) => ({ file, count })),
    downloadsByMinute: bucketEventsByMinute(allDownloadEvents.map((event) => event.at)),
    detailViewsByMinute: bucketEventsByMinute(allDetailViewEvents),
    shares: shares.map(({ downloadEvents: _downloadEvents, detailViewEvents: _detailViewEvents, ...share }) => share)
  };
}
}
