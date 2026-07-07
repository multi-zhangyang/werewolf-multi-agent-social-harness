const OPENAI_RESOURCE_PATHS = ["/chat/completions", "/responses"] as const;

export function endpointUrlFromBaseUrl(baseUrl: string, resourcePath: string, envName: string): string {
  const url = normalizeHttpUrl(baseUrl, envName);
  assertNotResourceEndpoint(url, envName, OPENAI_RESOURCE_PATHS);
  url.pathname = joinPaths(url.pathname, resourcePath);
  return urlToString(url);
}

export function baseUrlFromEndpointUrl(endpointUrl: string, resourcePath: string, envName: string): string {
  const url = normalizeHttpUrl(endpointUrl, envName);
  const path = trimTrailingSlashes(url.pathname);
  if (!path.endsWith(resourcePath)) {
    throw new Error(`${envName} must end with the standard protocol path ${resourcePath}.`);
  }
  const nextPath = path.slice(0, path.length - resourcePath.length);
  url.pathname = nextPath || "/";
  return urlToString(url);
}

export function normalizeSdkBaseUrl(baseUrl: string, envName: string, forbiddenResourcePaths: readonly string[] = OPENAI_RESOURCE_PATHS): string {
  const url = normalizeHttpUrl(baseUrl, envName);
  assertNotResourceEndpoint(url, envName, forbiddenResourcePaths);
  url.pathname = trimTrailingSlashes(url.pathname) || "/";
  return urlToString(url);
}

export function validateEndpointUrl(endpointUrl: string, resourcePath: string, envName: string): string {
  const url = normalizeHttpUrl(endpointUrl, envName);
  const path = trimTrailingSlashes(url.pathname);
  if (!path.endsWith(resourcePath)) {
    throw new Error(`${envName} must end with the standard protocol path ${resourcePath}.`);
  }
  url.pathname = path;
  return urlToString(url);
}

function normalizeHttpUrl(value: string, envName: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${envName} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${envName} must use http or https.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${envName} must not include query parameters or a hash fragment.`);
  }
  return url;
}

function assertNotResourceEndpoint(url: URL, envName: string, resourcePaths: readonly string[]): void {
  const path = trimTrailingSlashes(url.pathname);
  const matched = resourcePaths.find((resourcePath) => path.endsWith(resourcePath));
  if (matched) {
    throw new Error(`${envName} must be a SDK base URL, not a full ${matched} endpoint.`);
  }
}

function joinPaths(basePath: string, resourcePath: string): string {
  const base = trimTrailingSlashes(basePath);
  return `${base === "/" ? "" : base}${resourcePath}`;
}

function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

function urlToString(url: URL): string {
  if (url.pathname === "/") return url.origin;
  return url.toString().replace(/\/+$/, "");
}
