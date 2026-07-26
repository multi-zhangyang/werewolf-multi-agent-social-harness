import express from "express";
import { assertLocalResearchArtifactAccess } from "../artifactAccess";
import { contentTypeForArtifactFile, isFileReadNotFound, resolveRegisteredTournamentArtifactFile } from "../artifactFiles";
import {
  getTournamentArtifactSetForBaseDir,
  listTournamentArtifactSetsForBaseDir,
  loadTournamentArtifactSetIndex
} from "../artifactSetStore";
import type { ServerContext } from "../context";
import { serializeTournamentArtifactSet } from "../dto";
import { HttpError } from "../httpValidation";
import { readFile } from "node:fs/promises";

export function registerTournamentArtifactRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, tournamentArtifactBaseDir } = context;

app.get("/api/tournament-artifacts", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    res.json({
      artifactSets: listTournamentArtifactSetsForBaseDir(tournamentArtifactBaseDir).map(serializeTournamentArtifactSet)
    });
  } catch (error) {
    next(error);
  }
});

app.get(/^\/api\/tournament-artifacts\/([^/]+)\/files\/(.+)$/, async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    const params = req.params as unknown as string[];
    const artifactSetId = params[0];
    const requestedPath = params[1];
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    const file = await resolveRegisteredTournamentArtifactFile(artifactSet, requestedPath, tournamentArtifactBaseDir);
    let content: Buffer;
    try {
      content = await readFile(file.absolutePath);
    } catch (error) {
      if (isFileReadNotFound(error)) {
        res.status(404).json({ error: "tournament artifact file not found" });
        return;
      }
      throw new HttpError(500, "tournament artifact file could not be read");
    }
    res.type(contentTypeForArtifactFile(file.relativePath)).send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-artifacts/:id", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    res.json(serializeTournamentArtifactSet(artifactSet));
  } catch (error) {
    next(error);
  }
});
}
