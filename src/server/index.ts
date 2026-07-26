import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServerContext, host, port, type ServerAppDependencies } from "./context";
import { HttpError } from "./httpValidation";
import { publicApiFailureFromError } from "./apiFailure";
import { registerSystemRoutes } from "./routes/system";
import { registerArtifactRecoveryAuditRoutes } from "./routes/artifactRecoveryAudits";
import { registerMatchRegistryRoutes } from "./routes/matchRegistry";
import { registerComparisonRoutes } from "./routes/comparisons";
import { registerMatchLifecycleRoutes } from "./routes/matchLifecycle";
import { registerCheckpointRoutes } from "./routes/checkpoints";
import { registerMatchRunRoutes } from "./routes/matchRun";
import { registerExperimentRunRoutes } from "./routes/experimentRuns";
import { registerTournamentRunRoutes } from "./routes/tournamentRun";
import { registerExperimentMatrixRoutes } from "./routes/experimentMatrix";
import { registerTournamentArtifactRoutes } from "./routes/tournamentArtifacts";
import { registerTournamentShareRoutes } from "./routes/tournamentShares";

export type { ServerAppDependencies } from "./context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServerApp(dependencies: ServerAppDependencies = {}): express.Express {
const app = express();
// This server is local-by-default, but avoid advertising the framework even
// when an operator places it behind a deployment-specific authenticated proxy.
app.disable("x-powered-by");
const context = createServerContext(dependencies);

app.use(express.json({ limit: "2mb" }));

registerSystemRoutes(app, context);
registerArtifactRecoveryAuditRoutes(app, context);
registerMatchRegistryRoutes(app, context);
registerComparisonRoutes(app, context);
registerMatchLifecycleRoutes(app, context);
registerCheckpointRoutes(app, context);
registerMatchRunRoutes(app, context);
registerExperimentRunRoutes(app, context);
registerTournamentRunRoutes(app, context);
registerExperimentMatrixRoutes(app, context);
registerTournamentArtifactRoutes(app, context);
registerTournamentShareRoutes(app, context);

app.use(express.static(path.resolve(__dirname, "../../dist")));

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, "../../dist/index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const failure = publicApiFailureFromError(error);
  const status = error instanceof HttpError ? error.status : 500;
  res.status(status).json({
    error: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.providerFailure ? { providerFailure: failure.providerFailure } : {})
  });
});


return app;
}

const app = createServerApp();

if (isMainModule()) {
  app.listen(port, host, () => {
    console.log(`Werewolf API listening on http://${host}:${port}`);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const current = fileURLToPath(import.meta.url);
  const resolvedEntry = path.resolve(entry);
  return resolvedEntry === current || resolvedEntry.endsWith(path.normalize("src/server/index.ts"));
}
