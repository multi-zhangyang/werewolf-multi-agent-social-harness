import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { createServerContext, host, port } from "./context";
import { registerConfigurationRoutes } from "./routes/model-config";
import { registerArchiveRoutes } from "./archives";
import { registerCharacterRoutes } from "./characters";
import { registerRunRoutes } from "./routes/runs";
import { registerStudyRoutes } from "./routes/studies";
import { RunError } from "../runtime/types";
import { registerPartnerRoutes } from "./routes/partners";
import { PartnerError } from "../partners/service";
import { WorldError } from "../partners/world";

const directory = path.dirname(fileURLToPath(import.meta.url));

/** Shared server context, created once at module scope. Exported for
 * in-process tooling (e.g. UI audits registering a scripted room). */
export const context = createServerContext();

export function createServerApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  registerPartnerRoutes(app, context);
  registerCharacterRoutes(app, context);
  registerRunRoutes(app, context);
  registerStudyRoutes(app, context);
  app.post("/api/rooms", (_request, response) => response.status(410).json({ message: "请使用新的互动入口" }));
  app.delete("/api/archives/:archiveId", (_request, response) => response.status(405).json({ message: "历史归档为只读" }));
  registerConfigurationRoutes(app, context);
  registerArchiveRoutes(app, context);
  app.get("/api/health", (_request, response) => response.json({ ok: true, storage: context.storage.snapshot() }));
  app.use(express.static(path.resolve(directory, "../../dist")));
  app.get("*path", (_request, response) => {
    response.sendFile(path.resolve(directory, "../../dist/index.html"));
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof RunError) { response.status(error.statusCode).json({ message: error.message }); return; }
    if (error instanceof PartnerError) { response.status(error.statusCode).json({ message: error.message }); return; }
    if (error instanceof WorldError) { response.status(error.statusCode).json({ message: error.message }); return; }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "INVALID_REQUEST",
        message: "请检查填写的内容",
        fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
      return;
    }
    response.status(500).json({ error: "ROOM_START_FAILED", message: errorMessage(error) });
  });
  return app;
}

const app = createServerApp();

if (isMainModule()) {
  context.partners.store.recover();
  context.runs.store.recoverInterrupted();
  context.studies.recoverInterrupted();
  // Fail loudly instead of dying silently: surface process-level failures
  // with a scrubbed, grep-able reason so an external supervisor can restart.
  process.on("unhandledRejection", (reason) => {
    console.error("[society] unhandled rejection:", errorMessage(reason));
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    console.error("[society] uncaught exception:", errorMessage(error));
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });
  const server = app.listen(port, host, () => {
    console.log(`Society listening on http://${host}:${port}`);
  });
  let shuttingDown = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shuttingDown) {
      console.error(`[society] second ${signal}; exiting immediately.`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    shuttingDown = true;
    const graceMs = positiveInteger(process.env.SOCIETY_SHUTDOWN_GRACE_MS, 15_000);
    console.log(`[society] ${signal}; closing rooms and provider activations (grace ${graceMs}ms).`);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    context.liveConnections.closeAll();
    context.runs.stopAll();
    context.interventions.stopAll();
    context.partners.stopAll();
    context.studies.stopAll();
    void Promise.race([Promise.allSettled([context.interventions.settled(), context.partners.settled(), context.studies.settledAll(), ...[...context.runs.live.values()].map(run => run.settled())]), new Promise(resolve => setTimeout(resolve, graceMs))]).then(async () => {
      server.closeAllConnections();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
      context.runs.store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url) || entry.endsWith("src/server/index.ts");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\brp_[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .slice(0, 800);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
