/**
 * Request authentication for the Society API (AGENTS.md §18 / P0-05).
 *
 * Role model:
 *  - anonymous spectator: public projection only, always;
 *  - room participant: their own token (human rooms) — self POV and their
 *    own actions only;
 *  - room owner: the per-room control token returned at creation — pause,
 *    resume, remove, model switches, omniscient viewing of that room;
 *  - operator: `SOCIETY_OPERATOR_TOKEN` — global operations (season reset,
 *    model config / settings writes, forensic archive). Room ownership never
 *    escalates into global operator authority.
 *
 * Tokens are read from `Authorization: Bearer`, the `x-player-token` header,
 * or the `society_token` HttpOnly cookie (set for SSE/EventSource clients).
 * Tokens are deliberately never accepted from the URL or request body.
 */
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import type { SocietyRoom } from "../society/room";

export interface ServerAuth {
  operatorTokenConfigured(): boolean;
  isOperatorToken(token?: string): boolean;
}

export function createServerAuth(env: NodeJS.ProcessEnv = process.env): ServerAuth {
  const operatorToken = env.SOCIETY_OPERATOR_TOKEN?.trim();
  return {
    operatorTokenConfigured: () => Boolean(operatorToken),
    isOperatorToken: (token) => Boolean(token && operatorToken && safeEqual(token, operatorToken))
  };
}

export function tokenFromRequest(request: Request): string | undefined {
  const header = request.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const alt = request.header("x-player-token");
  if (alt) return alt.trim();
  const cookie = request.header("cookie");
  const cookieMatch = cookie?.match(/(?:^|;\s*)society_token=([^;]+)/);
  if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
  return undefined;
}

/** Set the HttpOnly cookie EventSource-based SSE clients can send back. */
export function setTokenCookie(response: import("express").Response, token: string): void {
  response.setHeader(
    "Set-Cookie",
    `society_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
  );
}

export interface RoomAuthority {
  /** The request carries this room's owner token. */
  owner: boolean;
  /** The request carries a valid participant (player) token and its seat. */
  participantActorId?: string;
}

/** Owner / participant authority for one room. */
export function roomAuthorityFor(request: Request, room: SocietyRoom): RoomAuthority {
  const token = tokenFromRequest(request);
  if (!token) return { owner: false };
  const participantActorId = room.actorForToken(token);
  return {
    owner: room.isOwnerToken(token),
    ...(participantActorId ? { participantActorId } : {})
  };
}

/** Global authority is always an explicitly configured operator token. */
export function isOperatorFor(auth: ServerAuth, request: Request): boolean {
  const token = tokenFromRequest(request);
  return auth.isOperatorToken(token);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guard for global (operator) writes — season reset, model config, settings.
 * Sends the 403 itself and returns false when the request is not authorized.
 */
export function requireGlobalOperator(
  request: Request,
  response: import("express").Response,
  auth: ServerAuth
): boolean {
  if (isOperatorFor(auth, request)) return true;
  response.status(403).json({
    error: "OPERATOR_REQUIRED",
    message: auth.operatorTokenConfigured()
      ? "A valid operator token is required."
      : "Global operations are disabled until SOCIETY_OPERATOR_TOKEN is configured."
  });
  return false;
}
