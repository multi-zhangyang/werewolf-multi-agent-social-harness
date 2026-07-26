import express from "express";
import { openTournamentOrchestration } from "../../harness/tournament";
import { assertLocalOperatorRegistryAccess } from "../artifactAccess";
import type { ServerContext } from "../context";
import { serializeExperimentRunIndexEntry, serializeExperimentRunRecord } from "../dto";
import { HttpError } from "../httpValidation";

export function registerExperimentRunRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, experimentRunBaseDir } = context;

app.get("/api/experiments/runs", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    if (!experimentRunBaseDir) throw new HttpError(404, "Experiment run authority is not configured.");
    const authority = await openTournamentOrchestration({ baseDirectory: experimentRunBaseDir });
    const entries = await authority.runStore.list();
    res.json({
      artifactVersion: "server.experiment-run-index.v1",
      kind: "experiment-run-index",
      entries: entries.map(serializeExperimentRunIndexEntry)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/runs/:runSetId", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    if (!experimentRunBaseDir) throw new HttpError(404, "Experiment run authority is not configured.");
    const authority = await openTournamentOrchestration({ baseDirectory: experimentRunBaseDir });
    const entry = await authority.runStore.get(req.params.runSetId);
    if (!entry) throw new HttpError(404, "Experiment run was not found.");
    res.json(serializeExperimentRunRecord(entry));
  } catch (error) {
    next(error);
  }
});
}
