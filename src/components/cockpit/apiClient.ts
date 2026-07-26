import { isRecord } from "./formatters";

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : typeof body === "string" ? body : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body as T;
}
