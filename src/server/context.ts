import { SocietyRoomRegistry } from "../society/room";
import { FileSeasonStore, defaultSeasonPath } from "../society/season";
import { loadRegistry, seedRegistryFromEnv, type ModelRegistry } from "../society/models";
import { RoomArchiveStore } from "../society/persistence";

export interface ServerContext {
  rooms: SocietyRoomRegistry;
  /** Cross-game memory shared by every room in this process (the Society Season). */
  season: FileSeasonStore;
  /** Provider / model / context-policy registry (non-secret parts persisted). */
  models: ModelRegistry;
  /** Rolling room checkpoints (data/rooms/<roomId>/checkpoint.json). */
  archive: RoomArchiveStore;
}

export function createServerContext(): ServerContext {
  const models = loadRegistry();
  seedRegistryFromEnv(models);
  return {
    rooms: new SocietyRoomRegistry(),
    season: new FileSeasonStore(defaultSeasonPath()),
    models,
    archive: new RoomArchiveStore()
  };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";