import { SocietyRoomRegistry } from "../society/room";

export interface ServerContext {
  rooms: SocietyRoomRegistry;
}

export function createServerContext(): ServerContext {
  return { rooms: new SocietyRoomRegistry() };
}

export const port = Number(process.env.PORT ?? 8787);
export const host = process.env.HOST ?? "127.0.0.1";
