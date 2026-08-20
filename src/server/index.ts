import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { createServerContext, host, port } from "./context";
import { registerRoomRoutes } from "./routes/rooms";
import { registerSocialTruthRoutes } from "./routes/social-truth";
import { registerCharacterRoutes } from "./characters";
import { registerTemplateRoutes } from "./templates";
import type { AgentModelBinding } from "../society/models";

const directory = path.dirname(fileURLToPath(import.meta.url));

export function createServerApp(): express.Express {
  const app = express();
  const context = createServerContext();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  registerCharacterRoutes(app, context);
  registerTemplateRoutes(app, context);
  registerRoomRoutes(app, context);
  registerSocialTruthRoutes(app, context);
  recoverInterruptedRooms(context);
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
  // Fail loudly instead of dying silently: a long-running room server must
  // surface process-level failures with a scrubbed, grep-able reason so an
  // external supervisor can restart it.
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

/**
 * Restart recovery (P3): rooms whose last checkpoint was interrupted are
 * rehydrated from it — world state, profiles, model bindings, the paused
 * seats and the event stream — and held paused for an explicit resume.
 * Sessions and memories come back from disk per agent. Human rooms are left
 * archived (player tokens are not persisted).
 */
function recoverInterruptedRooms(context: ReturnType<typeof createServerContext>): void {
  for (const checkpoint of context.archive.interrupted()) {
    try {
      const room = context.rooms.create({
        id: checkpoint.roomId,
        scenarioId: checkpoint.snapshot.scenarioId,
        profiles: (checkpoint.profiles ?? []).map((profile) => ({
          ...profile,
          // Pre-CharacterId checkpoints: resolve the stable id from the
          // character library, or pin a clearly-legacy id instead of guessing.
          characterId: profile.characterId ?? resolveLegacyCharacterId(context, checkpoint.roomId, profile)
        })),
        rounds: checkpoint.snapshot.world.totalTurns,
        seasonMode: checkpoint.seasonMode ?? "season",
        modelRegistry: context.models,
        limiter: context.limiter,
        ...(checkpoint.seasonMode === "season" ? { season: context.season } : {}),
        restore: {
          worldState: checkpoint.worldState!,
          rounds: checkpoint.snapshot.world.totalTurns,
          ...(checkpoint.ownerToken ? { ownerToken: checkpoint.ownerToken } : {}),
          ...(checkpoint.agentBindings ? { agentBindings: checkpoint.agentBindings as Record<string, AgentModelBinding> } : {}),
          ...(checkpoint.agentMinds ? { agentMinds: checkpoint.agentMinds } : {}),
          ...(checkpoint.pausedAgents ? { pausedAgents: checkpoint.pausedAgents } : {}),
          ...(checkpoint.envelopes?.length ? { events: checkpoint.envelopes } : {}),
          ...(checkpoint.replayEnvelopes?.length ? { replayEvents: checkpoint.replayEnvelopes } : {})
        }
      });
      room.recoverFromCheckpoint();
      console.log(`[society] recovered ${checkpoint.snapshot.scenarioId} room ${checkpoint.roomId} from checkpoint (paused, awaiting resume)`);
    } catch (error) {
      console.warn(`[society] could not recover room ${checkpoint.roomId}:`, errorMessage(error));
    }
  }
}

/** Stable id for a profile restored from a pre-CharacterId checkpoint. */
function resolveLegacyCharacterId(
  context: ReturnType<typeof createServerContext>,
  roomId: string,
  profile: { id: string; displayName: string }
): string {
  const matches = context.characters.idsForDisplayName(profile.displayName);
  if (matches.length === 1) return matches[0];
  console.warn(
    `[society] checkpoint ${roomId}: no unique character id for '${profile.displayName}' ` +
    `(matches: ${matches.join(", ") || "none"}); using a legacy id.`
  );
  return `legacy:${roomId}:${profile.id}`;
}
