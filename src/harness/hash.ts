import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function hashStableState(value: unknown): string {
  const serialized = JSON.stringify(normalizeForHash(value));
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
