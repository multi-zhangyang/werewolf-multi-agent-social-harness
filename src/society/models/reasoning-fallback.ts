type JsonObject = Record<string, unknown>;

export type EffectiveReasoningEffort = "xhigh" | "high" | "provider-default";

export interface ReasoningFallbackNotice {
  kind: "reasoning-downgrade";
  modelId?: string;
  requestedEffort: "xhigh" | "high";
  effectiveEffort: "high" | "provider-default";
  status: number;
  errorCode: string;
  message: string;
  retrying: true;
}

export interface ReasoningFallbackOptions {
  fetchImpl?: typeof fetch;
  onNotice?(notice: ReasoningFallbackNotice): void;
}

const effectiveEffortByScope = new Map<string, EffectiveReasoningEffort>();
const capabilityNoticeByScope = new Map<string, Omit<ReasoningFallbackNotice, "modelId" | "requestedEffort" | "effectiveEffort">>();

/**
 * Provider-neutral reasoning negotiation. Only an explicit capability error
 * triggers xhigh → high → provider default; unrelated failures are returned
 * untouched so authentication, quota and transport errors remain visible.
 */
export function reasoningFallbackFetch(options: ReasoningFallbackOptions = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const payload = jsonBody(init?.body);
    if (!payload) return fetchImpl(input, init);
    const requested = requestedEffort(payload);
    if (requested !== "xhigh" && requested !== "high") return fetchImpl(input, init);

    const scope = capabilityScope(input, payload);
    const cached = effectiveEffortByScope.get(scope);
    if (requested === "xhigh" && cached === "high") {
      notifyCached(options.onNotice, payload, scope, "xhigh", "high");
      return fetchImpl(input, withReasoningEffort(init, payload, "high"));
    }
    if (cached === "provider-default") {
      notifyCached(options.onNotice, payload, scope, requested, "provider-default");
      return fetchImpl(input, withoutReasoningEffort(init, payload));
    }

    if (requested === "high") return tryHighThenDefault(fetchImpl, input, init, payload, scope, options.onNotice);

    const xhighResponse = await fetchImpl(input, init);
    if (xhighResponse.ok) {
      effectiveEffortByScope.set(scope, "xhigh");
      return xhighResponse;
    }
    const xhighError = await reasoningCapabilityError(xhighResponse, "xhigh");
    if (!xhighError) return xhighResponse;

    const xhighNotice: ReasoningFallbackNotice = {
      kind: "reasoning-downgrade",
      modelId: modelId(payload),
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      status: xhighResponse.status,
      errorCode: xhighError.code,
      message: xhighError.message,
      retrying: true
    };
    notify(options.onNotice, xhighNotice);
    capabilityNoticeByScope.set(scope, noticeBasis(xhighNotice));
    return tryHighThenDefault(fetchImpl, input, init, payload, scope, options.onNotice);
  };
}

/** Test/process lifecycle helper; capability knowledge is never persisted. */
export function clearReasoningCapabilityCache(): void {
  effectiveEffortByScope.clear();
  capabilityNoticeByScope.clear();
}

async function tryHighThenDefault(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  payload: JsonObject,
  scope: string,
  onNotice: ReasoningFallbackOptions["onNotice"]
): Promise<Response> {
  const highResponse = await fetchImpl(input, withReasoningEffort(init, payload, "high"));
  if (highResponse.ok) {
    effectiveEffortByScope.set(scope, "high");
    return highResponse;
  }
  const highError = await reasoningCapabilityError(highResponse, "high");
  if (!highError) return highResponse;
  const notice: ReasoningFallbackNotice = {
    kind: "reasoning-downgrade",
    modelId: modelId(payload),
    requestedEffort: "high",
    effectiveEffort: "provider-default",
    status: highResponse.status,
    errorCode: highError.code,
    message: highError.message,
    retrying: true
  };
  notify(onNotice, notice);
  capabilityNoticeByScope.set(scope, noticeBasis(notice));
  const defaultResponse = await fetchImpl(input, withoutReasoningEffort(init, payload));
  if (defaultResponse.ok) effectiveEffortByScope.set(scope, "provider-default");
  return defaultResponse;
}

function notifyCached(
  callback: ReasoningFallbackOptions["onNotice"],
  payload: JsonObject,
  scope: string,
  requestedEffort: "xhigh" | "high",
  effectiveEffort: "high" | "provider-default"
): void {
  const basis = capabilityNoticeByScope.get(scope);
  notify(callback, {
    kind: "reasoning-downgrade",
    modelId: modelId(payload),
    requestedEffort,
    effectiveEffort,
    status: basis?.status ?? 0,
    errorCode: basis?.errorCode ?? "REASONING_CAPABILITY_CACHED",
    message: basis?.message ?? `Using cached reasoning capability: ${effectiveEffort}.`,
    retrying: true
  });
}

function noticeBasis(notice: ReasoningFallbackNotice): Omit<ReasoningFallbackNotice, "modelId" | "requestedEffort" | "effectiveEffort"> {
  const { modelId: _modelId, requestedEffort: _requestedEffort, effectiveEffort: _effectiveEffort, ...basis } = notice;
  return basis;
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

function requestedEffort(payload: JsonObject): string | undefined {
  if (typeof payload.reasoning_effort === "string") return payload.reasoning_effort;
  const reasoning = payload.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return undefined;
  return typeof (reasoning as JsonObject).effort === "string"
    ? (reasoning as JsonObject).effort as string
    : undefined;
}

function modelId(payload: JsonObject): string | undefined {
  return typeof payload.model === "string" && payload.model ? payload.model : undefined;
}

function capabilityScope(input: RequestInfo | URL, payload: JsonObject): string {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return `${endpoint}\u0000${modelId(payload) ?? "default"}`;
}

function withReasoningEffort(init: RequestInit | undefined, payload: JsonObject, effort: "high"): RequestInit {
  const next = structuredClone(payload);
  if (typeof next.reasoning_effort === "string") next.reasoning_effort = effort;
  if (next.reasoning && typeof next.reasoning === "object" && !Array.isArray(next.reasoning)) {
    next.reasoning = { ...(next.reasoning as JsonObject), effort };
  }
  return withJsonBody(init, next);
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
  return withJsonBody(init, next);
}

function withJsonBody(init: RequestInit | undefined, payload: JsonObject): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify(payload) };
}

async function reasoningCapabilityError(
  response: Response,
  effort: "xhigh" | "high"
): Promise<{ code: string; message: string } | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  const error = await safeError(response);
  const searchable = `${error.code} ${error.param} ${error.type} ${error.rawMessage}`.toLowerCase();
  const namesReasoning = /reasoning|reasoning_effort|effort/.test(searchable);
  const namesEffort = searchable.includes(effort);
  const namesCapability = /unsupported|not supported|invalid value|unknown value|not allowed|unrecognized|enum/.test(searchable);
  if (!(namesCapability && (namesReasoning || namesEffort))) return undefined;
  return {
    code: error.code || `HTTP_${response.status}_REASONING_UNSUPPORTED`,
    message: sanitizeMessage(error.rawMessage, effort)
  };
}

async function safeError(response: Response): Promise<{
  code: string;
  type: string;
  param: string;
  rawMessage: string;
}> {
  const text = await response.clone().text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as JsonObject;
    const nested = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? parsed.error as JsonObject
      : parsed;
    return {
      code: stringField(nested.code),
      type: stringField(nested.type),
      param: stringField(nested.param),
      rawMessage: stringField(nested.message) || text
    };
  } catch {
    return { code: "", type: "", param: "", rawMessage: text };
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeMessage(message: string, effort: "xhigh" | "high"): string {
  const cleaned = message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"']+/g, "[endpoint]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return cleaned || `Provider does not support reasoning effort '${effort}'.`;
}

function notify(callback: ReasoningFallbackOptions["onNotice"], notice: ReasoningFallbackNotice): void {
  try {
    callback?.(notice);
  } catch {
    // Observability must never break the provider request lifecycle.
  }
}
