/**
 * API client helpers for the Society web app: the room owner token is
 * kept in localStorage and sent as `Authorization: Bearer` — never in URLs,
 * never in logs. The server also sets an HttpOnly `society_token` cookie on
 * authenticated requests, which EventSource-based SSE reconnects send back
 * automatically.
 */

const OWNER_TOKEN_KEY = "society:owner-token";

export function storedOwnerToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(OWNER_TOKEN_KEY) ?? undefined;
}

export function storeOwnerToken(token: string): void {
  if (typeof window === "undefined" || !token) return;
  window.localStorage.setItem(OWNER_TOKEN_KEY, token);
}

/** `fetch` with the room-owner token attached when one is stored. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = storedOwnerToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}