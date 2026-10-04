import { apiFetch } from "@/lib/api";
import type { CreatedRun, PartnerSnapshot } from "@/partners/api-types";

type Credentials = { ownerToken: string; playerToken?: string };
const key = (id: string) => `partners:credentials:${id}`;
const sessionCredentials = new Map<string, Credentials>();
export function credentials(id: string): Credentials | undefined {
  if (sessionCredentials.has(id)) return sessionCredentials.get(id);
  try { return JSON.parse(localStorage.getItem(key(id)) ?? "null") ?? undefined; } catch { return undefined; }
}
export function remember(id: string, value: Credentials) { sessionCredentials.set(id, value); try { localStorage.setItem(key(id), JSON.stringify(value)); } catch { /* Active credentials are kept in memory when browser storage is restricted. */ } }
export function rememberRun(run: CreatedRun) { remember(run.id, { ownerToken: run.ownerToken, playerToken: run.playerToken }); }

export async function request<T>(path: string, init: RequestInit = {}, id?: string, role: "owner" | "player" = "owner"): Promise<T> {
  const auth = id ? credentials(id) : undefined;
  const token = role === "player" ? auth?.playerToken ?? auth?.ownerToken : auth?.ownerToken;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await apiFetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error?.message ?? (typeof body.error === "string" ? body.error : `请求失败（${response.status}）`));
  return body as T;
}
export const post = <T,>(path: string, body: unknown, id?: string, role: "owner" | "player" = "owner") => request<T>(path, { method: "POST", body: JSON.stringify(body) }, id, role);

/** Preserve event objects across activity-only updates so a model tool never remounts the conversation. */
export function reconcile(previous: PartnerSnapshot | undefined, next: PartnerSnapshot) {
  if (!previous || previous.id !== next.id || previous.viewer.research !== next.viewer.research || previous.viewer.actorId !== next.viewer.actorId) return next;
  if (previous.version >= next.version) return previous;
  const oldEvents = new Map(previous.observation.events.map(event => [event.id, event]));
  const events = next.observation.events.map(event => {
    const old = oldEvents.get(event.id);
    return old && JSON.stringify(old) === JSON.stringify(event) ? old : event;
  });
  return { ...next, observation: { ...next.observation, events } };
}

export async function download(path: string, filename: string, id: string) {
  const value = await request<unknown>(path, {}, id);
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}
