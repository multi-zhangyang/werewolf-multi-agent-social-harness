import express from "express";
import { loadTournamentArtifactSetIndex } from "../artifactSetStore";
import type { ServerContext } from "../context";
import {
  artifactRecoveryAuditQueryFromRequest,
  artifactRecoveryAuditRecordMatchesQuery,
  serializeArtifactRecoveryAuditRecord
} from "../recoveryAudit";
import { listArtifactRecoveryAuditRecords } from "../store";
import { loadTournamentPublicShareIndex } from "../tournamentShares";

export function registerArtifactRecoveryAuditRoutes(app: express.Express, context: ServerContext): void {
const { tournamentArtifactBaseDir, loadServerArtifactStores } = context;

app.get("/api/artifact-recovery-audits", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const query = artifactRecoveryAuditQueryFromRequest(req.query);
    const filteredRecords = listArtifactRecoveryAuditRecords()
      .filter((record) => artifactRecoveryAuditRecordMatchesQuery(record, query))
      .map(serializeArtifactRecoveryAuditRecord);
    const records = filteredRecords.slice(query.offset, query.limit === undefined ? undefined : query.offset + query.limit);
    res.json({
      records,
      filters: {
        store: query.store ?? null,
        source: query.source ?? null,
        code: query.code ?? null
      },
      page: {
        total: filteredRecords.length,
        offset: query.offset,
        limit: query.limit ?? null,
        returned: records.length,
        hasMore: query.offset + records.length < filteredRecords.length
      }
    });
  } catch (error) {
    next(error);
  }
});
}
