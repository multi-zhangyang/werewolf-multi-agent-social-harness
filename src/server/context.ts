import { SocietyRoomRegistry } from "../society/room";
import { loadRegistry, seedRegistryFromEnv, type ModelRegistry } from "../society/models";
import { CharacterLibrary } from "./characters";
import { RosterTemplateStore } from "./templates";
import { limiterFromEnv, type ActivationLimiter } from "../society/activation-limiter";
import { createServerAuth, type ServerAuth } from "./auth";

export interface ServerContext {
  rooms: SocietyRoomRegistry;
  /** Provider / model / context-policy registry (non-secret parts persisted). */
  models: ModelRegistry;
  /** Built-in + user-defined characters (data/characters.json). */
  characters: CharacterLibrary;
  /** Saved create-room configurations (data/room-templates.json). */
  templates: RosterTemplateStore;
  /** Shared provider activation pool across all rooms. */
  limiter: ActivationLimiter;
  /** Operator/owner authorization for the API layer. */
  auth: ServerAuth;
}

export function createServerContext(): ServerContext {
  const models = loadRegistry();
  seedRegistryFromEnv(models);
  const characters = new CharacterLibrary();
  const rooms = new SocietyRoomRegistry();
  const limiter = limiterFromEnv();
  return {
    rooms,
    models,
    characters,
    templates: new RosterTemplateStore(),
    limiter,
    auth: createServerAuth()
  };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";