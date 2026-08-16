import { SocietyRoomRegistry } from "../society/room";
import { InMemorySeasonStore } from "../society/season";

export interface ServerContext {
  rooms: SocietyRoomRegistry;
  /** Cross-game memory shared by every room in this process. */
  season: InMemorySeasonStore;
}

export function createServerContext(): ServerContext {
  return { rooms: new SocietyRoomRegistry(), season: new InMemorySeasonStore() };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";
