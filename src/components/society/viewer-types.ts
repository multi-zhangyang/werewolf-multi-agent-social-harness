/**
 * Viewer-mode alias kept out of the server contract so the frontend data
 * layer can be unit-tested without importing server-side room types.
 */
export type SpectatorModeLike = "public" | "omniscient" | "agent-pov" | "postgame";
