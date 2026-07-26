import express from "express";
import {
  buildMatchComparisonArtifact,
  formatFilteredMatchComparisonMarkdown,
  formatMatchComparisonMarkdown,
  projectFilteredMatchComparison
} from "../../harness/matchComparison";
import { redactSecrets } from "../../harness/redaction";
import { artifactViewFromQuery, assertLocalOperatorRegistryAccess, setArtifactProjectionResponseHeaders } from "../artifactAccess";
import { projectMatchArtifactForView } from "../artifactViews";
import { persistComparisonArtifact, writeComparisonArtifactIndex } from "../comparisonArtifactStore";
import {
  comparisonFormatFromQuery,
  comparisonRowFilterFromQuery,
  downloadRequested,
  filteredComparisonRequested
} from "../comparisonQuery";
import type { ServerContext, TerminalMatchLiveProjection } from "../context";
import { serializeStoredMatch } from "../dto";
import { getMatchForRead, listMatchesForRead, saveComparison } from "../store";

export function registerMatchRegistryRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, matchArtifactBaseDir, comparisonArtifactBaseDir, liveMatchProjections, loadServerArtifactStores, loadMatchArtifactIndex } = context;

app.get("/api/matches", async (_req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(_req, artifactAccessBindHost);
    await loadServerArtifactStores();
    res.json(listMatchesForRead().map(serializeStoredMatch));
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadServerArtifactStores();
    const match = getMatchForRead(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    res.json(serializeStoredMatch(match));
  } catch (error) {
    next(error);
  }
});

/**
 * Ephemeral running-table view. This deliberately cannot expose a trajectory,
 * checkpoint, command, or postgame artifact: it is only a server projection
 * of safe public facts at a committed boundary.
 */
app.get("/api/matches/:id/live", async (req, res, next) => {
  try {
    const current = liveMatchProjections.get(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (current) {
      res.json(current);
      return;
    }
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatchForRead(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    const lifecycle: TerminalMatchLiveProjection["lifecycle"] =
      match.status === "running" ? "running" : match.artifact?.status === "truncated" ? "truncated" : match.status === "failed" ? "failed" : "completed";
    res.json({
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId: match.id,
      lifecycle,
      artifactAvailable: Boolean(match.artifact)
    } satisfies TerminalMatchLiveProjection);
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/artifact", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatchForRead(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const projected = projectMatchArtifactForView(match.artifact, view);
    setArtifactProjectionResponseHeaders(res, view);
    if (downloadRequested(req.query)) {
      const shortId = match.id.slice(0, 8);
      res.setHeader("Content-Disposition", `attachment; filename="${shortId}-match-${view}.json"`);
    }
    res.json(projected);
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/compare/:candidateId", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const format = comparisonFormatFromQuery(req.query);
    const rowFilter = comparisonRowFilterFromQuery(req.query);
    const filteredRequested = filteredComparisonRequested(req.query, rowFilter);
    const baseline = getMatchForRead(req.params.id);
    const candidate = getMatchForRead(req.params.candidateId);
    if (!baseline || !candidate) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!baseline.artifact || !candidate.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const baselineArtifact = projectMatchArtifactForView(baseline.artifact, view);
    const candidateArtifact = projectMatchArtifactForView(candidate.artifact, view);
    const comparison = redactSecrets(
      buildMatchComparisonArtifact({
        baseline: baselineArtifact,
        candidate: candidateArtifact,
        view,
        createdAt: new Date(0).toISOString()
      })
    );
    // Registry artifacts are an API-visible truth surface. A full/debug
    // comparison may be requested explicitly, but must remain request-local so
    // a later registry read cannot expose it without the same explicit intent.
    // Filtered projections are also request-local pure views.
    if (!filteredRequested && view !== "full") {
      saveComparison(comparison);
      await persistComparisonArtifact(comparison, comparisonArtifactBaseDir);
      await writeComparisonArtifactIndex(comparisonArtifactBaseDir);
    }
    const payload = filteredRequested
      ? redactSecrets(
          projectFilteredMatchComparison(comparison, rowFilter, {
            createdAt: new Date(0).toISOString()
          })
        )
      : comparison;
    const shortBaseline = baseline.id.slice(0, 8);
    const shortCandidate = candidate.id.slice(0, 8);
    const filenameStem = filteredRequested
      ? `${shortBaseline}-vs-${shortCandidate}-comparison-filtered`
      : `${shortBaseline}-vs-${shortCandidate}-comparison`;
    setArtifactProjectionResponseHeaders(res, view);
    if (format === "markdown") {
      const markdown = filteredRequested
        ? formatFilteredMatchComparisonMarkdown(payload as ReturnType<typeof projectFilteredMatchComparison>)
        : formatMatchComparisonMarkdown(comparison);
      if (downloadRequested(req.query)) {
        res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}.md"`);
      }
      res.type("text/markdown; charset=utf-8").send(markdown);
      return;
    }
    if (downloadRequested(req.query)) {
      res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}.json"`);
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});
}
