import { createHash } from "node:crypto";

export function hashStableState(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeForHash(value))).digest("hex");
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, key === "createdAt" ? "<timestamp>" : normalizeForHash(record[key])])
    );
  }
  return value;
}
