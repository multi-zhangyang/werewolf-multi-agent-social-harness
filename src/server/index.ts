import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { createServerContext, host, port } from "./context";
import { registerRoomRoutes } from "./routes/rooms";

const directory = path.dirname(fileURLToPath(import.meta.url));

export function createServerApp(): express.Express {
  const app = express();
  const context = createServerContext();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
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
  return error instanceof Error ? error.message : String(error);
}
