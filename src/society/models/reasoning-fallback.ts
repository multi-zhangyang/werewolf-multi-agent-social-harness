const unsupportedReasoningScopes = new Set<string>();

type JsonObject = Record<string, unknown>;

/** Prefer xhigh, then learn support from a successful parameter-free retry. */
export function reasoningFallbackFetch(): typeof fetch {
  return async (input, init) => {
    const payload = jsonBody(init?.body);
    if (!payload || !requestsXhigh(payload)) return fetch(input, init);

    const scope = capabilityScope(input, payload);
    if (unsupportedReasoningScopes.has(scope)) {
      return fetch(input, withoutReasoningEffort(init, payload));
    }

    const response = await fetch(input, init);
    if (response.status !== 400 && response.status !== 422) return response;

    const fallback = await fetch(input, withoutReasoningEffort(init, payload));
    if (fallback.ok) {
      unsupportedReasoningScopes.add(scope);
      return fallback;
    }
    return response;
  };
}

function jsonBody(body: BodyInit | null | undefined): JsonObject | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

function requestsXhigh(payload: JsonObject): boolean {
  if (payload.reasoning_effort === "xhigh") return true;
  const reasoning = payload.reasoning;
  return Boolean(reasoning && typeof reasoning === "object" && (reasoning as JsonObject).effort === "xhigh");
}

function capabilityScope(input: RequestInfo | URL, payload: JsonObject): string {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const model = typeof payload.model === "string" ? payload.model : "default";
  return `${endpoint}\u0000${model}`;
}

function withoutReasoningEffort(init: RequestInit | undefined, payload: JsonObject): RequestInit {
  const next = structuredClone(payload);
  delete next.reasoning_effort;
  if (next.reasoning && typeof next.reasoning === "object" && !Array.isArray(next.reasoning)) {
    const reasoning = { ...(next.reasoning as JsonObject) };
    delete reasoning.effort;
    if (Object.keys(reasoning).length) next.reasoning = reasoning;
    else delete next.reasoning;
  }
  const headers = new Headers(init?.headers);
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify(next) };
}
