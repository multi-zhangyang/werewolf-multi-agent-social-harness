import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { createServerContext, host, port } from "./context";
import { registerRoomRoutes } from "./routes/rooms";
import { registerCharacterRoutes } from "./characters";
import { registerTemplateRoutes } from "./templates";

const directory = path.dirname(fileURLToPath(import.meta.url));

/** Shared server context, created once at module scope. */
const context = createServerContext();

export function createServerApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  registerCharacterRoutes(app, context);
  registerTemplateRoutes(app, context);
  registerRoomRoutes(app, context);
  app.use(express.static(path.resolve(directory, "../../dist")));
  app.get("*path", (_request, response) => {
    response.sendFile(path.resolve(directory, "../../dist/index.html"));
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "INVALID_REQUEST",
        message: "Room configuration is invalid.",
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
  app.listen(port, host, () => {
    console.log(`Society listening on http://${host}:${port}`);
  });
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