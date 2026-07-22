import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function hashStableState(value: unknown): string {
  return hashNormalizedValue(normalizeForHash(value, true));
}

/**
 * Stable JSON hash without the artifact-only `createdAt` timestamp mask.
 * Configuration/spec identities must distinguish a domain field that happens
 * to be named `createdAt`; replay-state hashes retain their legacy mask above.
 */
export function hashStableJsonValue(value: unknown): string {
  return hashNormalizedValue(normalizeForHash(value, false));
}

function hashNormalizedValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Stable state hashing requires a JSON-serializable value.");
  }
  // Keep the existing synchronous, lowercase hexadecimal SHA-256 contract
  // while using a runtime-neutral implementation. This module is imported by
  // both Node artifact/replay code and browser cockpit projections; importing
  // `node:crypto` here makes Vite externalize the module and prevents React
  // from starting in development mode.
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

function normalizeForHash(value: unknown, maskCreatedAt: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeForHash(entry, maskCreatedAt));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [
          key,
          maskCreatedAt && key === "createdAt" ? "<timestamp>" : normalizeForHash(record[key], maskCreatedAt)
        ])
    );
  }
  return value;
}
