import { SocietyRoomRegistry } from "../society/room";
import { FileSeasonStore, defaultSeasonPath } from "../society/season";
import { loadRegistry, seedRegistryFromEnv, type ModelRegistry } from "../society/models";
import { RoomArchiveStore } from "../society/persistence";
import { CharacterLibrary } from "./characters";
import { RosterTemplateStore } from "./templates";
import { limiterFromEnv, type ActivationLimiter } from "../society/activation-limiter";
import { createServerAuth, type ServerAuth } from "./auth";

export interface ServerContext {
  rooms: SocietyRoomRegistry;
  /** Cross-game memory shared by every room in this process (the Society Season). */
  season: FileSeasonStore;
  /** Provider / model / context-policy registry (non-secret parts persisted). */
  models: ModelRegistry;
  /** Rolling room checkpoints (data/rooms/<roomId>/checkpoint.json). */
  archive: RoomArchiveStore;
  /** Built-in + user-defined characters (data/characters.json). */
  characters: CharacterLibrary;
  /** Saved create-room configurations (data/room-templates.json). */
  templates: RosterTemplateStore;
  /** Shared provider activation pool across all rooms (P3 backpressure). */
  limiter: ActivationLimiter;
  /** Operator/owner authorization for the API layer (§18). */
  auth: ServerAuth;
}

export function createServerContext(): ServerContext {
  const models = loadRegistry();
  seedRegistryFromEnv(models);
  // The season store resolves legacy display-name keys against the character
  // library during its v1→v2 migration, so the library must exist first.
  const characters = new CharacterLibrary();
  const rooms = new SocietyRoomRegistry();
  const archive = new RoomArchiveStore();
  const limiter = limiterFromEnv();
  return {
    rooms,
    season: new FileSeasonStore(defaultSeasonPath(), (displayName) => characters.idsForDisplayName(displayName)),
    models,
    archive,
    characters,
    templates: new RosterTemplateStore(),
    limiter,
    auth: createServerAuth()
  };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";
