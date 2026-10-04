import { defaultRegistryFile, loadRegistry, seedRegistryFromEnv, type ModelRegistry } from "../society/models";
import { CharacterLibrary } from "./characters";
import { createServerAuth, type ServerAuth } from "./auth";
import { StorageHealth } from "./storage";
import { SocietyStore } from "../runtime/store";
import { RunService } from "../runtime/run";
import { modelParticipantFactory } from "../runtime/participant";
import { StudyService } from "../runtime/studies";
import { PartnerStore } from "../partners/store";
import { PartnerService } from "../partners/service";
import { createSdkParticipant } from "../partners/agent";
import { InterventionService } from "../partners/interventions";

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
  partners: PartnerService;
  interventions: InterventionService;
  runs: RunService;
  studies: StudyService;
  /** Provider / model / context-policy registry (non-secret parts persisted). */
  models: ModelRegistry;
  /** Exact persistence target used by this context (tests may isolate it). */
  modelRegistryFile: string;
  /** Built-in + user-defined characters (data/characters.json). */
  characters: CharacterLibrary;
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
  const store = new SocietyStore(env.SOCIETY_DATABASE_FILE ?? "data/society.sqlite");
  const factory = modelParticipantFactory(models);
  const runs = new RunService(store, factory);
  const partners = new PartnerService(new PartnerStore(store.db), (mechanism) => createSdkParticipant(models, {
    psychology: mechanism === "full" ? "hybrid" : mechanism === "no-mind" ? "off" : mechanism === "record-only" ? "record-only" : "no-inertia" }));
  return {
    partners,
    interventions: new InterventionService(partners),
    runs,
    studies: new StudyService(store, factory, runs),
    models,
    modelRegistryFile,
    characters,
    auth: createServerAuth(env, env.HOST?.trim() || "127.0.0.1"),
    storage,
    liveConnections: new LiveConnectionRegistry()
  };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";
