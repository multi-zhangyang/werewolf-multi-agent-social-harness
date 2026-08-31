import { SocietyRoomRegistry } from "../society/room";
import { defaultRegistryFile, loadRegistry, seedRegistryFromEnv, type ModelRegistry } from "../society/models";
import { CharacterLibrary } from "./characters";
import { RosterTemplateStore } from "./templates";
import { limiterFromEnv, type ActivationLimiter } from "../society/activation-limiter";
import { createServerAuth, type ServerAuth } from "./auth";
import { StorageHealth } from "./storage";

export interface LiveConnection {
  readonly writableEnded: boolean;
  write(chunk: string): unknown;
  end(): unknown;
}

/** Process-local SSE registry so graceful shutdown can end streams before waiting on providers. */
export class LiveConnectionRegistry {
  private readonly connections = new Set<LiveConnection>();

  track(connection: LiveConnection): () => void {
    this.connections.add(connection);
    return () => this.connections.delete(connection);
  }

  closeAll(): void {
    for (const connection of this.connections) {
      if (connection.writableEnded) continue;
      connection.write(": society shutdown\n\n");
      connection.end();
    }
    this.connections.clear();
  }

  count(): number {
    return this.connections.size;
  }
}

export interface ServerContext {
  rooms: SocietyRoomRegistry;
  /** Provider / model / context-policy registry (non-secret parts persisted). */
  models: ModelRegistry;
  /** Exact persistence target used by this context (tests may isolate it). */
  modelRegistryFile: string;
  /** Built-in + user-defined characters (data/characters.json). */
  characters: CharacterLibrary;
  /** Saved create-room configurations (data/room-templates.json). */
  templates: RosterTemplateStore;
  /** Shared provider activation pool across all rooms. */
  limiter: ActivationLimiter;
  /** Operator/owner authorization for the API layer. */
  auth: ServerAuth;
  storage: StorageHealth;
  /** Open SSE responses owned by this process. */
  liveConnections: LiveConnectionRegistry;
}

export function createServerContext(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const modelRegistryFile = env.SOCIETY_MODEL_SETTINGS_FILE?.trim() || defaultRegistryFile();
  const storage = new StorageHealth();
  const models = loadRegistry(modelRegistryFile, storage);
  seedRegistryFromEnv(models);
  const characters = new CharacterLibrary(undefined, storage);
  const rooms = new SocietyRoomRegistry();
  const limiter = limiterFromEnv();
  return {
    rooms,
    models,
    modelRegistryFile,
    characters,
    templates: new RosterTemplateStore(undefined, storage),
    limiter,
    auth: createServerAuth(env, env.HOST?.trim() || "127.0.0.1"),
    storage,
    liveConnections: new LiveConnectionRegistry()
  };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";
