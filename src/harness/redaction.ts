const SECRET_ENV_NAMES = ["LLM_API_KEY", "OPENAI_API_KEY", "API_KEY", "TOKEN", "SECRET", "AUTHORIZATION"];

export function redactSecrets<T>(value: T): T;
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry)]));
  }
  return value;
}

export function redactSecretText(value: string): string {
  let redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9]*_(?:v\d+_)?(?=[A-Za-z0-9_:-]*\d)[A-Za-z0-9_:-]{24,}\b/g, "[PROVIDER_TOKEN_REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]");
  for (const secret of knownSecrets()) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function knownSecrets(): string[] {
  return SECRET_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.length >= 4 ? [value] : [];
  }).filter((value, index, all) => all.indexOf(value) === index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
